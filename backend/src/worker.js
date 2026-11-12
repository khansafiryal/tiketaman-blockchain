const { transition, audit } = require("./orders");
const { revertName } = require("./chain");

/**
 * Worker asinkron untuk transaksi blockchain. Webhook hanya mengantrekan job lalu langsung
 * membalas 200, sehingga Midtrans tidak menunggu konfirmasi blok. Gagal -> retry dengan backoff;
 * setelah batas percobaan -> refund_pending.
 */
function createWorker({ db, getChain, cfg, log = () => {} }) {
  let running = false;

  async function processMint(job, order) {
    const chain = getChain();
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(order.user_id);
    for (let i = 0; i < order.quantity; i++) {
      const exists = db.prepare("SELECT token_id FROM tickets WHERE order_id = ? AND order_index = ?").get(order.order_id, i);
      if (exists) continue; // sudah tercatat (retry setelah sebagian sukses)
      const ref = chain.orderRef(order.order_id, i);
      let minted;
      if (await chain.isProcessed(ref)) {
        minted = await chain.findMintedByRef(order.event_id, ref); // pulihkan dari log on-chain
      } else {
        minted = await chain.mint(order.event_id, user.wallet_address, ref);
      }
      db.prepare(`INSERT INTO tickets (token_id, event_id, order_id, order_index, owner_user_id, status, mint_tx, last_tx)
                  VALUES (?,?,?,?,?, 'active', ?, ?)`).run(minted.tokenId, order.event_id, order.order_id, i, user.id, minted.txHash, minted.txHash);
      log(`mint token #${minted.tokenId} untuk ${order.order_id} (tx ${minted.txHash.slice(0, 10)}...)`);
    }
    return "ticket_minted";
  }

  async function processResale(job, order) {
    const chain = getChain();
    const buyer = db.prepare("SELECT * FROM users WHERE id = ?").get(order.user_id);
    const ref = chain.orderRef(order.order_id, 0);
    let txHash;
    if (await chain.isProcessed(ref)) {
      txHash = "recovered";
    } else {
      const r = await chain.executeResale(order.resale_token_id, buyer.wallet_address, ref);
      txHash = r.txHash;
    }
    db.prepare(`UPDATE tickets SET owner_user_id = ?, status = 'active', list_price = NULL, last_tx = ?, updated_at = datetime('now')
                WHERE token_id = ?`).run(buyer.id, txHash, order.resale_token_id);
    log(`resale token #${order.resale_token_id} ke user ${buyer.id} (${order.order_id})`);
    return "ticket_transferred";
  }

  async function runJob(job) {
    const order = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(job.order_id);
    const from = order.status; // paid atau mint_failed
    if (!transition(db, order.order_id, from, "minting")) return;
    db.prepare("UPDATE chain_jobs SET status='running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?").run(job.id);
    try {
      const final = job.action === "mint" ? await processMint(job, order) : await processResale(job, order);
      transition(db, order.order_id, "minting", final);
      db.prepare("UPDATE chain_jobs SET status='done', last_error=NULL, updated_at = datetime('now') WHERE id = ?").run(job.id);
      audit(db, "worker", final, { orderId: order.order_id });
    } catch (err) {
      const attempts = db.prepare("SELECT attempts FROM chain_jobs WHERE id = ?").get(job.id).attempts;
      const reason = String(revertName(err)).slice(0, 200);
      transition(db, order.order_id, "minting", "mint_failed");
      if (attempts >= cfg.mint.maxAttempts) {
        transition(db, order.order_id, "mint_failed", "refund_pending");
        db.prepare("UPDATE chain_jobs SET status='failed', last_error=?, updated_at = datetime('now') WHERE id = ?").run(reason, job.id);
        audit(db, "worker", "refund_pending", { orderId: order.order_id, reason });
        log(`GAGAL permanen ${order.order_id}: ${reason} -> refund_pending`);
      } else {
        const delay = cfg.mint.backoffMs * 2 ** (attempts - 1);
        db.prepare("UPDATE chain_jobs SET status='queued', last_error=?, next_run_at=?, updated_at = datetime('now') WHERE id = ?")
          .run(reason, Date.now() + delay, job.id);
        log(`retry ${order.order_id} percobaan ${attempts}/${cfg.mint.maxAttempts}: ${reason}`);
      }
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const jobs = db.prepare("SELECT * FROM chain_jobs WHERE status='queued' AND next_run_at <= ? ORDER BY id").all(Date.now());
      for (const job of jobs) await runJob(job);
    } finally { running = false; }
  }

  let timer = null;
  return {
    tick,
    start(intervalMs = 250) { timer = setInterval(() => tick().catch((e) => log("worker error " + e.message)), intervalMs); },
    stop() { if (timer) clearInterval(timer); },
  };
}

module.exports = { createWorker };
