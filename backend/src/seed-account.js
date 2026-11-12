const crypto = require("crypto");
const { createCustodialWallet } = require("./wallet");
const { passwordHash } = require("./auth");
const catalog = require("./events");

function sampleAccount(db, cfg) {
  let user = db.prepare("SELECT * FROM users WHERE email = 'nadia@student.ub.ac.id'").get();
  if (!user) {
    const w = createCustodialWallet(cfg.walletEncKey);
    const r = db.prepare(`INSERT INTO users (name,email,identity_hash,wallet_address,wallet_key_enc,consent_at,password_hash)
      VALUES (?,'nadia@student.ub.ac.id',?,?,?,datetime('now'),?)`).run("Nadia Putri",
      crypto.createHash("sha256").update("sample-nadia").digest("hex"), w.address, w.encrypted, passwordHash("TiketAman123"));
    user = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid);
  }
  return user;
}
async function seedAccount(db, chain, userId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  for (const [index, state] of ["active", "active", "used", "listed", "pending", "failed", "expired"].entries()) {
    const e = catalog[index]; const orderId = `TA-SAMPLE-${userId}-${e.id}`;
    if (db.prepare("SELECT 1 FROM orders WHERE order_id=?").get(orderId)) continue;
    if (require("./orders").identityUsage(db, userId, e.id) >= e.maxPerIdentity) continue;
    const paid = ["active", "used", "listed"].includes(state);
    db.prepare(`INSERT INTO orders (order_id,kind,user_id,event_id,quantity,unit_price,service_fee,gross_amount,status,payment_type,paid_at)
      VALUES (?,'primary',?,?,1,?,?,?,?,?,?)`).run(orderId, userId, e.id, e.faceValue, e.serviceFee,
      e.faceValue + e.serviceFee, paid ? "ticket_minted" : state, paid ? "bank_transfer" : null, paid ? new Date().toISOString() : null);
    if (!paid) continue;
    const minted = await chain.mint(e.id, user.wallet_address, chain.orderRef(orderId, 0));
    let lastTx = minted.txHash;
    const price = Math.floor(e.faceValue * 1.05);
    if (state === "listed") lastTx = (await chain.list(minted.tokenId, price)).txHash;
    if (state === "used") lastTx = (await chain.checkIn(minted.tokenId, user.wallet_address)).txHash;
    db.prepare(`INSERT INTO tickets (token_id,event_id,order_id,order_index,owner_user_id,status,list_price,mint_tx,last_tx)
      VALUES (?,?,?,0,?,?,?,?,?)`).run(minted.tokenId, e.id, orderId, userId, state, state === "listed" ? price : null, minted.txHash, lastTx);
    db.prepare(`INSERT INTO payment_notifications (order_id,transaction_status,status_code,gross_amount,payment_type,signature_valid,result)
      VALUES (?,'settlement','200',?,'bank_transfer',1,'applied_paid')`).run(orderId, String(e.faceValue + e.serviceFee));
  }
}
module.exports = { sampleAccount, seedAccount };
