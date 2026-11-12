const crypto = require("crypto");
const { createCustodialWallet } = require("./wallet");
const { createChain } = require("./chain");
const catalog = require("./events");

async function seedResale({ db, cfg }) {
  const chain = createChain(cfg.chain);
  const names = ["Alya", "Bagas", "Citra", "Dimas", "Elena", "Farhan", "Gita", "Hana"];
  for (const e of catalog) {
    const orderId = `DEMO-SELLER-${e.id}`;
    if (db.prepare("SELECT 1 FROM orders WHERE order_id = ?").get(orderId)) continue;
    const wallet = createCustodialWallet(cfg.walletEncKey);
    const user = db.prepare(`INSERT INTO users (name,email,identity_hash,wallet_address,wallet_key_enc,consent_at)
      VALUES (?,?,?,?,?,datetime('now'))`).run(names[e.id - 1], `seller${e.id}@demo.ac.id`,
      crypto.createHash("sha256").update(`demo-seller-${e.id}`).digest("hex"), wallet.address, wallet.encrypted);
    db.prepare(`INSERT INTO orders (order_id,kind,user_id,event_id,quantity,unit_price,service_fee,gross_amount,status,paid_at,payment_type)
      VALUES (?,'primary',?,?,3,?,?,?,'ticket_minted',datetime('now'),'qris')`)
      .run(orderId, user.lastInsertRowid, e.id, e.faceValue, e.serviceFee, 3 * (e.faceValue + e.serviceFee));
    db.prepare(`INSERT INTO payment_notifications (order_id,transaction_status,status_code,gross_amount,payment_type,signature_valid,result)
      VALUES (?,'settlement','200',?,'qris',1,'applied_paid')`).run(orderId, String(3 * (e.faceValue + e.serviceFee)));
    for (let i = 0; i < 3; i++) {
      const minted = await chain.mint(e.id, wallet.address, chain.orderRef(orderId, i));
      const price = Math.floor(e.faceValue * [1, 1.05, 1.1][i]);
      const listed = await chain.list(minted.tokenId, price);
      db.prepare(`INSERT INTO tickets (token_id,event_id,order_id,order_index,owner_user_id,status,list_price,mint_tx,last_tx)
        VALUES (?,?,?,?,?,'listed',?,?,?)`).run(minted.tokenId, e.id, orderId, i, user.lastInsertRowid, price, minted.txHash, listed.txHash);
    }
  }
}
module.exports = { seedResale };
