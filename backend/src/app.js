const path = require("path");
const crypto = require("crypto");
const express = require("express");
const QRCode = require("qrcode");
const { verifySignature, computeSignature, mapStatus, createSnapClient } = require("./midtrans");
const { createCustodialWallet } = require("./wallet");
const { revertName } = require("./chain");
const { estimateMdr } = require("./fees");
const { HttpError, transition, newOrderId, identityUsage, eventSoldOrReserved, audit, tx } = require("./orders");

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Pembatas laju sederhana (fixed window per IP) untuk meredam bot saat penjualan dibuka. */
function rateLimiter(limitPerMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const w = hits.get(key) || { start: now, n: 0 };
    if (now - w.start > 60_000) { w.start = now; w.n = 0; }
    w.n += 1;
    hits.set(key, w);
    if (w.n > limitPerMinute) return res.status(429).json({ error: "Terlalu banyak permintaan, coba lagi sebentar" });
    next();
  };
}

function createApp({ cfg, db, getChain, worker, log = () => {} }) {
  const app = express();
  const snap = createSnapClient(cfg);
  app.use(express.json({ limit: "100kb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));
  const limiter = rateLimiter(cfg.rateLimitPerMinute);
  const { passwordHash, installAuth } = require("./auth");
  const auth = installAuth(app, db, cfg, limiter);
  let exampleQueue = Promise.resolve();
  const fillAccount = (userId) => {
    const task = exampleQueue.then(async () => {
      await cfg.seedReady;
      await require("./seed-account").seedAccount(db, getChain(), userId);
    });
    exampleQueue = task.catch(() => {});
    return task;
  };
  app.post("/api/examples/account", asyncH(async (req, res) => {
    if (!cfg.demoTools || !req.userId) throw new HttpError(404, "Tidak tersedia");
    await fillAccount(req.userId);
    res.json({ ok: true });
  }));

  const getUser = (id) => {
    const u = db.prepare("SELECT id, name, email, wallet_address, created_at FROM users WHERE id = ?").get(Number(id));
    if (!u) throw new HttpError(404, "Pengguna tidak ditemukan");
    return u;
  };
  const getEvent = (id) => {
    const e = db.prepare("SELECT * FROM events WHERE id = ?").get(Number(id));
    if (!e) throw new HttpError(404, "Event tidak ditemukan");
    return e;
  };

  app.get("/api/health", (req, res) => res.json({ ok: true, paymentMode: cfg.paymentMode, demoTools: cfg.demoTools }));

  // ------------------------------------------------------------ registrasi + wallet custodial
  app.post("/api/users", limiter, (req, res) => {
    const { name, nim, consent, password } = req.body || {};
    const email = String(req.body?.email || "").trim().toLowerCase();
    const hash = cfg.requireAuth ? passwordHash(password) : null;
    if (!name || !email || !nim) throw new HttpError(400, "Nama, email kampus, dan NIM wajib diisi");
    if (consent !== true) throw new HttpError(400, "Persetujuan pemrosesan data pribadi wajib diberikan");
    if (!String(email).toLowerCase().endsWith(cfg.campusEmailSuffix)) throw new HttpError(400, "Gunakan email kampus");
    if (!/^\d{8,20}$/.test(String(nim))) throw new HttpError(400, "Format NIM tidak valid");
    const identityHash = crypto.createHash("sha256").update(`${nim}:${cfg.identitySalt}`).digest("hex");
    if (db.prepare("SELECT 1 FROM users WHERE identity_hash = ? OR email = ?").get(identityHash, email))
      throw new HttpError(409, "Identitas atau email sudah terdaftar (satu identitas = satu akun)");
    const w = createCustodialWallet(cfg.walletEncKey);
    const r = db.prepare(`INSERT INTO users (name, email, identity_hash, wallet_address, wallet_key_enc, consent_at)
                          VALUES (?,?,?,?,?, datetime('now'))`).run(name, email.toLowerCase(), identityHash, w.address, w.encrypted);
    audit(db, `user:${r.lastInsertRowid}`, "register", { email });
    if (hash) {
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, r.lastInsertRowid);
      auth.login(res, getUser(r.lastInsertRowid));
    }
    res.status(201).json(getUser(r.lastInsertRowid));
  });

  app.get("/api/users", (req, res) => res.json(db.prepare("SELECT id, name, email, wallet_address FROM users ORDER BY id").all()));
  app.get("/api/my/orders", (req, res) => {
    if (!req.userId) throw new HttpError(401, "Silakan masuk");
    res.json(db.prepare(`SELECT o.*, e.name AS event_name FROM orders o JOIN events e ON e.id = o.event_id
      WHERE o.user_id = ? ORDER BY o.created_at DESC, o.rowid DESC`).all(req.userId));
  });
  app.get("/api/users/:id", (req, res) => res.json(getUser(req.params.id)));

  // ------------------------------------------------------------ event
  app.get("/api/events", (req, res) => {
    const rows = db.prepare("SELECT * FROM events ORDER BY id").all();
    res.json(rows.map((e) => ({ ...e, reserved: eventSoldOrReserved(db, e.id), resale_cap: Math.floor(e.face_value * e.max_resale_bps / 10000) })));
  });
  app.get("/api/events/:id", (req, res) => res.json(getEvent(req.params.id)));

  // ------------------------------------------------------------ checkout (penjualan primer)
  app.post("/api/checkout", limiter, asyncH(async (req, res) => {
    const { userId, eventId } = req.body || {};
    const quantity = Number(req.body?.quantity);
    const user = getUser(userId);
    const ev = getEvent(eventId);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > ev.max_per_identity)
      throw new HttpError(422, `Jumlah tiket 1 sampai ${ev.max_per_identity}`);

    const order = tx(db, () => {
      const used = identityUsage(db, user.id, ev.id);
      if (used + quantity > ev.max_per_identity)
        throw new HttpError(422, `Kuota per identitas terlampaui (sudah ${used}, maks ${ev.max_per_identity})`, { used });
      if (eventSoldOrReserved(db, ev.id) + quantity > ev.supply) throw new HttpError(409, "Tiket habis");
      const orderId = newOrderId("TA", ev.id);
      const gross = quantity * (ev.face_value + ev.service_fee);
      db.prepare(`INSERT INTO orders (order_id, kind, user_id, event_id, quantity, unit_price, service_fee, gross_amount, status)
                  VALUES (?, 'primary', ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(orderId, user.id, ev.id, quantity, ev.face_value, ev.service_fee, gross);
      return { orderId, gross };
    });

    const snapRes = await snap.createTransaction({
      transaction_details: { order_id: order.orderId, gross_amount: order.gross },
      item_details: [
        { id: `EV${ev.id}`, price: ev.face_value, quantity, name: `Tiket ${ev.name}`.slice(0, 50) },
        { id: "FEE", price: ev.service_fee, quantity, name: "Biaya layanan" },
      ],
      customer_details: { first_name: user.name, email: user.email },
      enabled_payments: ["bca_va", "bni_va", "bri_va", "permata_va", "other_qris", "gopay", "shopeepay"],
      expiry: { unit: "minutes", duration: 15 },
    });
    db.prepare("UPDATE orders SET snap_token = ? WHERE order_id = ?").run(snapRes.token, order.orderId);
    audit(db, `user:${user.id}`, "checkout", { orderId: order.orderId, quantity });
    res.status(201).json({ orderId: order.orderId, grossAmount: order.gross, status: "pending", snapToken: snapRes.token, redirectUrl: snapRes.redirect_url });
  }));

  app.get("/api/orders/:orderId", (req, res) => {
    const o = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(req.params.orderId);
    if (!o) throw new HttpError(404, "Pesanan tidak ditemukan");
    const tickets = db.prepare("SELECT token_id, status, mint_tx FROM tickets WHERE order_id = ? ORDER BY order_index").all(o.order_id);
    res.json({ ...o, tickets });
  });
  app.get("/api/admin/orders", (req, res) => res.json(db.prepare("SELECT * FROM orders ORDER BY created_at DESC, order_id DESC").all()));

  // ------------------------------------------------------------ webhook Midtrans
  app.post("/api/webhooks/midtrans", asyncH(async (req, res) => {
    const n = req.body || {};
    const logN = (valid, result) => db.prepare(`INSERT INTO payment_notifications
        (order_id, transaction_status, status_code, gross_amount, payment_type, signature_valid, result) VALUES (?,?,?,?,?,?,?)`)
      .run(n.order_id ?? null, n.transaction_status ?? null, n.status_code ?? null, n.gross_amount ?? null, n.payment_type ?? null, valid ? 1 : 0, result);

    // 1) Verifikasi signature
    if (!verifySignature(n, cfg.midtrans.serverKey)) {
      logN(false, "rejected_signature");
      log(`webhook DITOLAK (signature salah) order ${n.order_id}`);
      return res.status(403).json({ error: "Signature tidak valid" });
    }
    // 2) Pesanan harus ada dan nominal harus sama persis
    const order = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(n.order_id);
    if (!order) { logN(true, "unknown_order"); return res.status(404).json({ error: "Pesanan tidak dikenal" }); }
    if (Number(n.gross_amount) !== order.gross_amount) {
      logN(true, "rejected_amount");
      return res.status(400).json({ error: "Nominal tidak sesuai pesanan" });
    }
    // 3) Challenge-response opsional ke API status Midtrans
    if (cfg.midtrans.verifyStatus) {
      const s = await snap.getStatus(order.order_id);
      if (s && s.transaction_status !== n.transaction_status) { logN(true, "status_mismatch"); return res.status(409).json({ error: "Status tidak cocok" }); }
    }
    const target = mapStatus(n);
    if (!target || target === "pending" || target === "refunded") { logN(true, `noted_${n.transaction_status}`); return res.json({ result: "noted" }); }

    // 4) Idempotensi: transisi compare-and-set hanya dari 'pending'
    const result = tx(db, () => {
      const extra = target === "paid" ? { paid_at: new Date().toISOString(), payment_type: n.payment_type, midtrans_transaction_id: n.transaction_id || null }
                                      : { payment_type: n.payment_type || null };
      const changed = transition(db, order.order_id, "pending", target, extra);
      if (!changed) return "duplicate_ignored";
      if (target === "paid") {
        db.prepare("INSERT OR IGNORE INTO chain_jobs (order_id, action, status) VALUES (?,?, 'queued')")
          .run(order.order_id, order.kind === "primary" ? "mint" : "resale");
      }
      if (order.kind === "resale" && target !== "paid") {
        // pembayaran resale gagal: tiket kembali tersedia di pasar resale
      }
      return `applied_${target}`;
    });
    logN(true, result);
    log(`webhook ${n.transaction_status} ${order.order_id} -> ${result}`);
    res.json({ result }); // balas cepat; mint diproses worker secara asinkron
    if (result === "applied_paid" && worker) setImmediate(() => worker.tick().catch(() => {}));
  }));

  // ------------------------------------------------------------ simulator pembayaran (hanya mode simulator)
  app.post("/api/simulator/pay", asyncH(async (req, res) => {
    if (cfg.paymentMode !== "simulator") throw new HttpError(404, "Simulator nonaktif");
    const { orderId, transactionStatus = "settlement", paymentType = "qris" } = req.body || {};
    const order = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId);
    if (!order) throw new HttpError(404, "Pesanan tidak ditemukan");
    if (!["settlement", "expire", "deny"].includes(transactionStatus)) throw new HttpError(400, "Skenario tidak valid");
    if (order.status !== "pending") throw new HttpError(409, "Pesanan ini sudah diproses. Kembali ke Pesanan Saya.");
    const statusCode = transactionStatus === "settlement" ? "200" : transactionStatus === "expire" ? "407" : "202";
    const body = { order_id: orderId, status_code: statusCode, gross_amount: `${order.gross_amount}.00`,
      transaction_status: transactionStatus, payment_type: paymentType, fraud_status: "accept",
      transaction_id: crypto.randomUUID(), transaction_time: new Date().toISOString() };
    body.signature_key = computeSignature(body, cfg.midtrans.serverKey);
    const r = await fetch(`${req.protocol}://${req.get("host")}/api/webhooks/midtrans`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    res.status(r.status).json(await r.json());
  }));

  // ------------------------------------------------------------ tiket milik pengguna
  app.get("/api/users/:id/tickets", (req, res) => {
    const u = getUser(req.params.id);
    res.json(db.prepare(`SELECT t.*, e.name AS event_name, e.face_value, e.max_resale_bps FROM tickets t JOIN events e ON e.id = t.event_id
                         WHERE t.owner_user_id = ? ORDER BY t.token_id`).all(u.id)
      .map((t) => ({ ...t, resale_cap: Math.floor(t.face_value * t.max_resale_bps / 10000), explorer: `${cfg.chain.explorerBase}/tx/${t.last_tx}` })));
  });

  // ------------------------------------------------------------ penjualan ulang resmi
  app.post("/api/tickets/:tokenId/list", asyncH(async (req, res) => {
    const tokenId = Number(req.params.tokenId);
    const { userId } = req.body || {};
    const price = Number(req.body?.price);
    const t = db.prepare("SELECT t.*, e.face_value, e.max_resale_bps FROM tickets t JOIN events e ON e.id = t.event_id WHERE token_id = ?").get(tokenId);
    if (!t) throw new HttpError(404, "Tiket tidak ditemukan");
    if (t.owner_user_id !== Number(userId)) throw new HttpError(403, "Bukan pemilik tiket");
    if (t.status !== "active") throw new HttpError(409, `Tiket berstatus ${t.status}`);
    const cap = Math.floor(t.face_value * t.max_resale_bps / 10000);
    if (!Number.isInteger(price) || price <= 0 || price > cap) throw new HttpError(422, `Harga melebihi batas resale Rp${cap}`, { cap });
    try {
      const r = await getChain().list(tokenId, price); // kontrak memeriksa ulang batas harga
      db.prepare("UPDATE tickets SET status='listed', list_price=?, last_tx=?, updated_at=datetime('now') WHERE token_id=?").run(price, r.txHash, tokenId);
      res.json({ tokenId, price, cap, txHash: r.txHash });
    } catch (e) { throw new HttpError(422, `Ditolak smart contract: ${revertName(e)}`); }
  }));

  app.get("/api/resale", (req, res) => res.json(db.prepare(
    `SELECT t.token_id, t.event_id, t.list_price, t.owner_user_id, e.name AS event_name, e.venue, e.starts_at, e.face_value, e.service_fee,
      u.name AS seller_name, EXISTS(SELECT 1 FROM orders o WHERE o.resale_token_id=t.token_id AND o.status IN ('pending','paid','minting','mint_failed')) AS reserved
     FROM tickets t JOIN events e ON e.id = t.event_id JOIN users u ON u.id=t.owner_user_id
     WHERE t.status = 'listed' ORDER BY t.event_id, t.list_price`).all()));

  app.post("/api/resale/checkout", limiter, asyncH(async (req, res) => {
    const { userId, tokenId } = req.body || {};
    const buyer = getUser(userId);
    const t = db.prepare("SELECT * FROM tickets WHERE token_id = ?").get(Number(tokenId));
    if (!t || t.status !== "listed") throw new HttpError(409, "Tiket tidak sedang dijual");
    if (t.owner_user_id === buyer.id) throw new HttpError(409, "Tidak dapat membeli tiket sendiri");
    const ev = getEvent(t.event_id);
    const order = tx(db, () => {
      const busy = db.prepare(`SELECT 1 FROM orders WHERE resale_token_id = ? AND status IN ('pending','paid','minting','mint_failed')`).get(t.token_id);
      if (busy) throw new HttpError(409, "Tiket sedang dalam proses pembayaran pembeli lain");
      if (identityUsage(db, buyer.id, ev.id) + 1 > ev.max_per_identity) throw new HttpError(422, "Kuota per identitas terlampaui");
      const orderId = newOrderId("RS", ev.id);
      const gross = t.list_price + ev.service_fee;
      db.prepare(`INSERT INTO orders (order_id, kind, user_id, event_id, quantity, unit_price, service_fee, gross_amount, resale_token_id, status)
                  VALUES (?, 'resale', ?, ?, 1, ?, ?, ?, ?, 'pending')`).run(orderId, buyer.id, ev.id, t.list_price, ev.service_fee, gross, t.token_id);
      return { orderId, gross };
    });
    const snapRes = await snap.createTransaction({
      transaction_details: { order_id: order.orderId, gross_amount: order.gross },
      customer_details: { first_name: buyer.name, email: buyer.email },
      expiry: { unit: "minutes", duration: 15 },
    });
    db.prepare("UPDATE orders SET snap_token = ? WHERE order_id = ?").run(snapRes.token, order.orderId);
    res.status(201).json({ orderId: order.orderId, grossAmount: order.gross, redirectUrl: snapRes.redirect_url });
  }));

  // ------------------------------------------------------------ check-in
  const signQr = (payload) => crypto.createHmac("sha256", cfg.qrSecret).update(payload).digest("hex").slice(0, 32);
  app.get("/api/tickets/:tokenId/qr", (req, res) => {
    const tokenId = Number(req.params.tokenId);
    const userId = Number(req.query.userId);
    const t = db.prepare("SELECT * FROM tickets WHERE token_id = ?").get(tokenId);
    if (!t || t.owner_user_id !== userId) throw new HttpError(403, "Bukan pemilik tiket");
    const exp = Math.floor(Date.now() / 1000) + 60; // QR berlaku 60 detik (berputar)
    const payload = `${tokenId}.${userId}.${exp}`;
    res.json({ qr: `${payload}.${signQr(payload)}`, expiresAt: exp });
  });

  app.get("/api/qr.svg", asyncH(async (req, res) => {
    const svg = await QRCode.toString(String(req.query.data || "").slice(0, 200), { type: "svg", margin: 1, width: 220 });
    res.type("image/svg+xml").send(svg);
  }));

  app.post("/api/gate/checkin", asyncH(async (req, res) => {
    const parts = String(req.body?.qr || "").split(".");
    if (parts.length !== 4) throw new HttpError(400, "QR tidak valid");
    const [tokenId, userId, exp, sig] = parts;
    const payload = `${tokenId}.${userId}.${exp}`;
    const expected = signQr(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new HttpError(401, "Tanda tangan QR salah");
    if (Number(exp) < Date.now() / 1000) throw new HttpError(401, "QR kedaluwarsa, minta pemilik memuat ulang");
    const t = db.prepare("SELECT * FROM tickets WHERE token_id = ?").get(Number(tokenId));
    if (!t) throw new HttpError(404, "Tiket tidak ditemukan");
    if (t.status === "used") throw new HttpError(409, "Tiket sudah dipakai");
    if (t.owner_user_id !== Number(userId)) throw new HttpError(403, "Pemegang tiket tidak cocok");
    const holder = db.prepare("SELECT wallet_address, name FROM users WHERE id = ?").get(t.owner_user_id);
    try {
      const r = await getChain().checkIn(Number(tokenId), holder.wallet_address);
      db.prepare("UPDATE tickets SET status='used', last_tx=?, updated_at=datetime('now') WHERE token_id=?").run(r.txHash, Number(tokenId));
      res.json({ ok: true, tokenId: Number(tokenId), holder: holder.name, txHash: r.txHash });
    } catch (e) { throw new HttpError(409, `Ditolak smart contract: ${revertName(e)}`); }
  }));

  // ------------------------------------------------------------ laporan & rekonsiliasi
  app.get("/api/reports/reconciliation", asyncH(async (req, res) => {
    const ev = getEvent(req.query.eventId || 1);
    const chain = getChain();
    const minted = await chain.mintedEvents(ev.id);
    const resales = await chain.resaleEvents();
    const orders = db.prepare("SELECT * FROM orders WHERE event_id = ? ORDER BY created_at, order_id").all(ev.id);
    const settled = db.prepare(`SELECT order_id, gross_amount FROM payment_notifications
                                WHERE signature_valid = 1 AND transaction_status = 'settlement' AND result = 'applied_paid'`).all();
    const paidMap = new Map(settled.map((s) => [s.order_id, Number(s.gross_amount)]));
    const rows = orders.map((o) => {
      const refs = Array.from({ length: o.quantity }, (_, i) => chain.orderRef(o.order_id, i));
      const onchain = o.kind === "primary" ? minted.filter((m) => refs.includes(m.orderRef)).length
                                            : resales.filter((r) => r.orderRef === refs[0]).length;
      const paid = paidMap.get(o.order_id) || 0;
      const expectOnchain = ["ticket_minted", "ticket_transferred"].includes(o.status) ? o.quantity : 0;
      const expectPaid = ["paid", "minting", "mint_failed", "refund_pending", "ticket_minted", "ticket_transferred"].includes(o.status) ? o.gross_amount : 0;
      const match = paid === expectPaid && onchain === expectOnchain;
      const mdr = paid ? estimateMdr(o.payment_type, paid) : 0;
      return { order_id: o.order_id, kind: o.kind, status: o.status, quantity: o.quantity, gross_amount: o.gross_amount,
        payment_type: o.payment_type, paid_amount: paid, onchain_tokens: onchain, mdr_estimate: mdr, match };
    });
    const ok = rows.filter((r) => ["ticket_minted", "ticket_transferred"].includes(r.status));
    const sum = (arr, f) => arr.reduce((a, r) => a + f(r), 0);
    const primaryOk = ok.filter((r) => r.kind === "primary");
    const resaleOk = ok.filter((r) => r.kind === "resale");
    const resaleValue = sum(resaleOk, (r) => r.gross_amount - ev.service_fee);
    const summary = {
      event: ev.name,
      orders_total: rows.length,
      orders_matched: rows.filter((r) => r.match).length,
      tickets_onchain: minted.length,
      gross_collected: sum(rows, (r) => r.paid_amount),
      face_value_revenue: sum(primaryOk, (r) => r.quantity * ev.face_value),
      service_fee_revenue: sum(ok, (r) => r.quantity * ev.service_fee),
      resale_commission: Math.round(resaleValue * cfg.resaleCommissionBps / 10000),
      organizer_resale_share: sum(resales.filter((r) => resaleOk.some((o) => chain.orderRef(o.order_id, 0) === r.orderRef)), (r) => r.organizerShare),
      mdr_estimate: sum(rows, (r) => r.mdr_estimate),
      refund_pending: rows.filter((r) => r.status === "refund_pending").length,
    };
    summary.platform_net = summary.service_fee_revenue + summary.resale_commission - summary.mdr_estimate;
    summary.organizer_payout = summary.face_value_revenue + summary.organizer_resale_share;
    summary.seller_payout = resaleValue - summary.resale_commission - summary.organizer_resale_share;
    summary.refund_liability = sum(rows.filter((r) => r.status === "refund_pending"), (r) => r.paid_amount);
    res.json({ summary, rows });
  }));

  // ------------------------------------------------------------ penanganan error
  app.use((err, req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    log("ERROR " + (err.stack || err.message));
    res.status(500).json({ error: "Kesalahan server" });
  });
  return app;
}

function seedEvent(db, e) {
  db.prepare(`INSERT OR REPLACE INTO events (id, name, venue, starts_at, face_value, service_fee, supply, max_resale_bps, organizer_share_bps, max_per_identity)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(e.id, e.name, e.venue, e.startsAt, e.faceValue, e.serviceFee, e.supply, e.maxResaleBps, e.organizerShareBps, e.maxPerIdentity);
}

module.exports = { createApp, seedEvent };
