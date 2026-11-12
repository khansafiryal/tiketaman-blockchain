// Uji end-to-end: backend + webhook Midtrans (signature asli) + smart contract di jaringan Hardhat lokal.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { startHardhatNode, deployContract } = require("./helpers");
const { loadConfig } = require("../src/config");
const { openDb } = require("../src/db");
const { createChain, abi } = require("../src/chain");
const { createWorker } = require("../src/worker");
const { createApp, seedEvent } = require("../src/app");
const { computeSignature } = require("../src/midtrans");
const { decrypt } = require("../src/wallet");

const PORT_RPC = 8546;
const SERVER_KEY = "SB-Mid-server-DUMMY-KEY-UNTUK-UJI"; // kunci uji, bukan kunci asli
const results = [];
const logs = [];
const record = (id, scenario, expected, actual, pass) => results.push({ id, scenario, expected, actual, pass });

let node, base, server, db, cfg, realChain, chainRef, worker;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, url, body, b = base) {
  const r = await fetch(b + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
function notification(order, transaction_status, { payment_type = "qris", amount, key = SERVER_KEY, forgeSig } = {}) {
  const status_code = transaction_status === "settlement" ? "200" : transaction_status === "expire" ? "407" : transaction_status === "deny" ? "202" : "201";
  const n = { order_id: order.orderId, status_code, gross_amount: `${amount ?? order.grossAmount}.00`, transaction_status,
    payment_type, fraud_status: "accept", transaction_id: `trx-${Math.random().toString(16).slice(2)}` };
  n.signature_key = forgeSig || computeSignature(n, key);
  return n;
}
async function waitStatus(orderId, statuses, timeout = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const o = (await api("GET", `/api/orders/${orderId}`)).body;
    if (statuses.includes(o.status)) return o;
    await wait(100);
  }
  return (await api("GET", `/api/orders/${orderId}`)).body;
}

describe("TiketAman end-to-end (sandbox lokal)", () => {
  before(async () => {
    node = await startHardhatNode(PORT_RPC);
    const rpcUrl = `http://127.0.0.1:${PORT_RPC}`;
    const dep = await deployContract(rpcUrl);
    cfg = loadConfig({
      REQUIRE_AUTH: "false", // suite integrasi webhook/kontrak; autentikasi diuji terpisah
      PAYMENT_MODE: "simulator", MIDTRANS_SERVER_KEY: SERVER_KEY, RPC_URL: rpcUrl, OPERATOR_PRIVATE_KEY: dep.operatorKey,
      GATE_PRIVATE_KEY: dep.gateKey, CONTRACT_ADDRESS: dep.address, WALLET_ENCRYPTION_KEY: "11".repeat(32),
      IDENTITY_SALT: "salt-uji", QR_HMAC_SECRET: "qr-uji", RATE_LIMIT_PER_MINUTE: "50", MINT_BACKOFF_MS: "50",
    });
    db = openDb(":memory:");
    seedEvent(db, { id: 1, name: "Brawijaya Music Fest 2026", venue: "Samantha Krida", startsAt: "2026-12-12T19:00:00+07:00",
      faceValue: 100_000, serviceFee: 5_000, supply: 500, maxResaleBps: 11_000, organizerShareBps: 5_000, maxPerIdentity: 4 });
    realChain = createChain(cfg.chain);
    chainRef = { current: realChain };
    const log = (m) => logs.push(m);
    worker = createWorker({ db, getChain: () => chainRef.current, cfg, log });
    worker.start(100);
    const app = createApp({ cfg, db, getChain: () => chainRef.current, worker, log });
    await new Promise((r) => { server = app.listen(0, r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    worker.stop();
    server.close();
    node.kill();
    const out = path.join(__dirname, "..", "..", "test-reports", "e2e-results.json");
    fs.writeFileSync(out, JSON.stringify({ results, logs }, null, 2));
  });

  let alice, bob, order1, aliceTokens;

  test("E2E-01..03 registrasi, wallet custodial, satu identitas satu akun", async () => {
    const r1 = await api("POST", "/api/users", { name: "Alya", email: "alya@student.ub.ac.id", nim: "245150700111001", consent: true });
    assert.equal(r1.status, 201); assert.match(r1.body.wallet_address, /^0x[0-9a-fA-F]{40}$/);
    alice = r1.body;
    record("E2E-01", "Registrasi email kampus + persetujuan data", "201, wallet custodial dibuat", `${r1.status}, ${alice.wallet_address.slice(0, 10)}...`, true);
    const r2 = await api("POST", "/api/users", { name: "Alya2", email: "alya2@student.ub.ac.id", nim: "245150700111001", consent: true });
    assert.equal(r2.status, 409);
    record("E2E-02", "Registrasi ulang dengan NIM yang sama (akun ganda)", "409 ditolak", `${r2.status} ${r2.body.error}`, true);
    const r3 = await api("POST", "/api/users", { name: "Budi", email: "budi@student.ub.ac.id", nim: "245150700111002", consent: false });
    assert.equal(r3.status, 400);
    record("E2E-03", "Registrasi tanpa persetujuan pemrosesan data", "400 ditolak", `${r3.status} ${r3.body.error}`, true);
    bob = (await api("POST", "/api/users", { name: "Budi", email: "budi@student.ub.ac.id", nim: "245150700111002", consent: true })).body;
  });

  test("E2E-04 checkout 2 tiket menghasilkan pesanan pending", async () => {
    const r = await api("POST", "/api/checkout", { userId: alice.id, eventId: 1, quantity: 2 });
    assert.equal(r.status, 201); assert.equal(r.body.grossAmount, 210_000); assert.equal(r.body.status, "pending");
    order1 = r.body;
    record("E2E-04", "Checkout 2 tiket @Rp100.000 + biaya layanan Rp5.000", "201 pending, gross Rp210.000", `${r.status} ${r.body.status}, Rp${r.body.grossAmount}`, true);
  });

  test("E2E-05 webhook dengan signature salah ditolak", async () => {
    const n = notification(order1, "settlement", { forgeSig: "ab".repeat(64) });
    const r = await api("POST", "/api/webhooks/midtrans", n);
    const o = (await api("GET", `/api/orders/${order1.orderId}`)).body;
    assert.equal(r.status, 403); assert.equal(o.status, "pending");
    record("E2E-05", "Notifikasi settlement dengan signature palsu", "403, status tetap pending", `${r.status}, ${o.status}`, true);
  });

  test("E2E-06 webhook dengan nominal yang diubah ditolak", async () => {
    const n = notification(order1, "settlement", { amount: 1_000 }); // signature valid untuk nominal palsu
    const r = await api("POST", "/api/webhooks/midtrans", n);
    assert.equal(r.status, 400);
    record("E2E-06", "Notifikasi settlement dengan gross_amount tidak sesuai pesanan", "400, tidak diproses", `${r.status} ${r.body.error}`, true);
  });

  test("E2E-07 webhook settlement valid -> tiket dicetak di blockchain", async () => {
    const r = await api("POST", "/api/webhooks/midtrans", notification(order1, "settlement"));
    assert.equal(r.status, 200); assert.equal(r.body.result, "applied_paid");
    const o = await waitStatus(order1.orderId, ["ticket_minted"]);
    assert.equal(o.status, "ticket_minted"); assert.equal(o.tickets.length, 2);
    aliceTokens = o.tickets.map((t) => t.token_id);
    for (const id of aliceTokens) assert.equal(await realChain.ownerOf(id), alice.wallet_address);
    record("E2E-07", "Notifikasi settlement valid (QRIS)", "200, status ticket_minted, 2 token milik wallet pembeli",
      `${r.status}, ${o.status}, token #${aliceTokens.join(", #")} on-chain`, true);
  });

  test("E2E-08 webhook ganda tidak menghasilkan token ganda (idempotensi)", async () => {
    const r = await api("POST", "/api/webhooks/midtrans", notification(order1, "settlement"));
    await wait(400);
    const minted = await realChain.mintedEvents(1);
    assert.equal(r.status, 200); assert.equal(r.body.result, "duplicate_ignored"); assert.equal(minted.length, 2);
    record("E2E-08", "Notifikasi settlement yang sama dikirim ulang", "200 duplicate_ignored, total token tetap 2",
      `${r.status} ${r.body.result}, token on-chain = ${minted.length}`, true);
  });

  test("E2E-09 notifikasi pending yang datang terlambat tidak mengubah status", async () => {
    const r = await api("POST", "/api/webhooks/midtrans", notification(order1, "pending"));
    const o = (await api("GET", `/api/orders/${order1.orderId}`)).body;
    assert.equal(o.status, "ticket_minted");
    record("E2E-09", "Notifikasi pending tiba setelah settlement (out of order)", "status tetap ticket_minted", `${r.status} ${r.body.result}, ${o.status}`, true);
  });

  test("E2E-10..11 skenario kedaluwarsa dan gagal", async () => {
    const oExp = (await api("POST", "/api/checkout", { userId: bob.id, eventId: 1, quantity: 1 })).body;
    const r1 = await api("POST", "/api/webhooks/midtrans", notification(oExp, "expire", { payment_type: "bank_transfer" }));
    const s1 = (await api("GET", `/api/orders/${oExp.orderId}`)).body;
    assert.equal(s1.status, "expired"); assert.equal(s1.tickets.length, 0);
    record("E2E-10", "VA tidak dibayar sampai batas waktu (expire)", "status expired, tanpa token", `${r1.status}, ${s1.status}, token = ${s1.tickets.length}`, true);
    const oDeny = (await api("POST", "/api/checkout", { userId: bob.id, eventId: 1, quantity: 1 })).body;
    const r2 = await api("POST", "/api/webhooks/midtrans", notification(oDeny, "deny", { payment_type: "gopay" }));
    const s2 = (await api("GET", `/api/orders/${oDeny.orderId}`)).body;
    assert.equal(s2.status, "failed");
    record("E2E-11", "Pembayaran e-wallet ditolak (deny)", "status failed, tanpa token", `${r2.status}, ${s2.status}, token = ${s2.tickets.length}`, true);
  });

  test("E2E-12 kuota per identitas", async () => {
    const r = await api("POST", "/api/checkout", { userId: alice.id, eventId: 1, quantity: 3 });
    assert.equal(r.status, 422);
    record("E2E-12", "Pemilik 2 tiket mencoba membeli 3 tiket lagi (batas 4)", "422 ditolak", `${r.status} ${r.body.error}`, true);
  });

  test("E2E-13 mint gagal sementara lalu berhasil lewat retry", async () => {
    let fails = 0;
    chainRef.current = { ...realChain, mint: async (...a) => { if (fails < 2) { fails++; throw new Error("RPC timeout (simulasi)"); } return realChain.mint(...a); } };
    const o = (await api("POST", "/api/checkout", { userId: bob.id, eventId: 1, quantity: 1 })).body;
    await api("POST", "/api/webhooks/midtrans", notification(o, "settlement", { payment_type: "bank_transfer" }));
    const s = await waitStatus(o.orderId, ["ticket_minted", "refund_pending"]);
    const job = db.prepare("SELECT attempts FROM chain_jobs WHERE order_id = ?").get(o.orderId);
    chainRef.current = realChain;
    assert.equal(s.status, "ticket_minted"); assert.equal(job.attempts, 3);
    record("E2E-13", "RPC gagal 2 kali saat mint (gangguan sementara)", "retry otomatis, akhirnya ticket_minted", `${s.status} setelah ${job.attempts} percobaan`, true);
  });

  test("E2E-14 mint gagal permanen -> refund_pending", async () => {
    chainRef.current = { ...realChain, mint: async () => { throw new Error("RPC tidak dapat dihubungi (simulasi)"); } };
    const carol = (await api("POST", "/api/users", { name: "Citra", email: "citra@student.ub.ac.id", nim: "245150700111003", consent: true })).body;
    const o = (await api("POST", "/api/checkout", { userId: carol.id, eventId: 1, quantity: 1 })).body;
    await api("POST", "/api/webhooks/midtrans", notification(o, "settlement"));
    const s = await waitStatus(o.orderId, ["refund_pending"]);
    const job = db.prepare("SELECT attempts, status FROM chain_jobs WHERE order_id = ?").get(o.orderId);
    chainRef.current = realChain;
    assert.equal(s.status, "refund_pending"); assert.equal(job.attempts, 3);
    record("E2E-14", "Pembayaran sukses, tetapi mint selalu gagal", "refund_pending setelah 3 percobaan", `${s.status}, job ${job.status}, ${job.attempts} percobaan`, true);
  });

  test("E2E-15..16 resale: di atas batas ditolak, tepat batas berhasil", async () => {
    const tokenId = aliceTokens[1];
    const r1 = await api("POST", `/api/tickets/${tokenId}/list`, { userId: alice.id, price: 115_000 });
    assert.equal(r1.status, 422);
    record("E2E-15", "Alya memasang tiket Rp115.000 (batas 110% = Rp110.000)", "422 ditolak", `${r1.status} ${r1.body.error}`, true);
    const r2 = await api("POST", `/api/tickets/${tokenId}/list`, { userId: alice.id, price: 110_000 });
    assert.equal(r2.status, 200);
    const ro = (await api("POST", "/api/resale/checkout", { userId: bob.id, tokenId })).body;
    await api("POST", "/api/webhooks/midtrans", notification(ro, "settlement", { payment_type: "shopeepay" }));
    const s = await waitStatus(ro.orderId, ["ticket_transferred", "refund_pending"]);
    assert.equal(s.status, "ticket_transferred");
    assert.equal(await realChain.ownerOf(tokenId), bob.wallet_address);
    record("E2E-16", "Listing Rp110.000, Budi membeli lewat resale resmi", "ticket_transferred, ownerOf = wallet Budi",
      `${s.status}, pemilik baru ${bob.wallet_address.slice(0, 10)}...`, true);
  });

  test("E2E-17 transfer langsung dari wallet custodial ditolak kontrak", async () => {
    const row = db.prepare("SELECT wallet_key_enc FROM users WHERE id = ?").get(alice.id);
    const w = new ethers.Wallet(decrypt(row.wallet_key_enc, cfg.walletEncKey), realChain.provider);
    const c = new ethers.Contract(cfg.chain.contractAddress, abi, w);
    let reason = "";
    try { await c.transferFrom.staticCall(alice.wallet_address, bob.wallet_address, aliceTokens[0]); } catch (e) { reason = e.revert?.name || e.shortMessage; }
    assert.equal(reason, "TransferDisabled");
    record("E2E-17", "Penjualan di luar platform: transferFrom langsung antar-wallet", "revert TransferDisabled", reason, true);
  });

  test("E2E-18..20 check-in dengan QR berputar", async () => {
    const tokenId = aliceTokens[0];
    const { qr } = (await api("GET", `/api/tickets/${tokenId}/qr?userId=${alice.id}`)).body;
    const r1 = await api("POST", "/api/gate/checkin", { qr });
    assert.equal(r1.status, 200); assert.equal((await realChain.ticket(tokenId)).used, true);
    record("E2E-18", "Check-in pertama dengan QR valid", "200, used = true on-chain", `${r1.status}, used = true`, true);
    const qr2 = (await api("GET", `/api/tickets/${tokenId}/qr?userId=${alice.id}`)).body.qr;
    const r2 = await api("POST", "/api/gate/checkin", { qr: qr2 });
    assert.equal(r2.status, 409);
    record("E2E-19", "Check-in kedua untuk tiket yang sama", "409 ditolak", `${r2.status} ${r2.body.error}`, true);
    const forged = qr2.replace(/\.[0-9a-f]+$/, ".deadbeefdeadbeefdeadbeefdeadbeef");
    const r3 = await api("POST", "/api/gate/checkin", { qr: forged });
    assert.equal(r3.status, 401);
    record("E2E-20", "QR hasil tangkapan layar yang diubah (tanda tangan salah)", "401 ditolak", `${r3.status} ${r3.body.error}`, true);
  });

  test("E2E-21 pembatas laju permintaan (anti-bot)", async () => {
    const strict = createApp({ cfg: { ...cfg, rateLimitPerMinute: 3 }, db, getChain: () => realChain, worker: null });
    const srv = await new Promise((r) => { const s = strict.listen(0, () => r(s)); });
    const b2 = `http://127.0.0.1:${srv.address().port}`;
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await api("POST", "/api/checkout", { userId: bob.id, eventId: 1, quantity: 0 }, b2)).status);
    srv.close();
    assert.equal(codes.at(-1), 429);
    record("E2E-21", "5 permintaan checkout beruntun dari IP sama (batas 3/menit)", "permintaan ke-4 dan ke-5 = 429", codes.join(", "), true);
  });

  test("E2E-22 laporan rekonsiliasi cocok antara pesanan, pembayaran, dan blockchain", async () => {
    const r = await api("GET", "/api/reports/reconciliation?eventId=1");
    assert.equal(r.status, 200);
    const s = r.body.summary;
    assert.equal(s.orders_matched, s.orders_total);
    record("E2E-22", "Rekonsiliasi pesanan vs notifikasi pembayaran vs token on-chain", "semua baris cocok",
      `${s.orders_matched}/${s.orders_total} cocok; token on-chain ${s.tickets_onchain}; refund_pending ${s.refund_pending}`, true);
    fs.writeFileSync(path.join(__dirname, "..", "..", "test-reports", "reconciliation-sample.json"), JSON.stringify(r.body, null, 2));
  });
});
