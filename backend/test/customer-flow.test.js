const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startHardhatNode, deployContract } = require("./helpers");
const { start } = require("../src/server");

test("akun pribadi, login/logout, katalog 8 event, bayar dan tiket event tambahan", async () => {
  let node, running;
  try {
    node = await startHardhatNode(18547);
    const dep = await deployContract("http://127.0.0.1:18547", { catalog: true });
    running = start({ PORT: "0", DEMO_TOOLS: "true", MIDTRANS_SERVER_KEY: "test", RPC_URL: "http://127.0.0.1:18547",
      OPERATOR_PRIVATE_KEY: dep.operatorKey, GATE_PRIVATE_KEY: dep.gateKey, CONTRACT_ADDRESS: dep.address,
      WALLET_ENCRYPTION_KEY: "11".repeat(32), IDENTITY_SALT: "test", QR_HMAC_SECRET: "test" });
    await new Promise((r) => running.server.listening ? r() : running.server.once("listening", r));
    const base = `http://127.0.0.1:${running.server.address().port}`;
    await require("../src/seed-resale").seedResale(running);
    let cookie = "";
    async function api(method, url, body, authenticated = true) {
      const r = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(authenticated ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
      return { status: r.status, body: await r.json() };
    }
    assert.equal((await api("POST", "/api/checkout", { userId: 1, eventId: 8, quantity: 2 })).status, 401);
    const form = { name: "Pembeli", email: "buyer@student.ub.ac.id", nim: "123456789", password: "password123", consent: true };
    assert.equal((await api("POST", "/api/users", { ...form, password: "short" })).status, 400);
    const user = await api("POST", "/api/users", form);
    assert.equal(user.status, 201);
    assert.equal((await api("GET", "/api/auth/me")).body.id, user.body.id);
    assert.equal((await api("GET", "/api/users")).status, 403);
    assert.equal((await api("GET", "/api/events")).body.length, 8);
    const listings = (await api("GET", "/api/resale")).body;
    assert.equal(listings.length, 24);
    for (const l of listings) assert.ok(l.list_price <= l.face_value * 1.1);
    assert.equal((await api("GET", "/api/health")).body.demoTools, true);
    const checkout = await api("POST", "/api/checkout", { userId: 999, eventId: 8, quantity: 2 });
    assert.equal(checkout.status, 201);
    assert.equal(checkout.body.grossAmount, 140000);
    const orderId = checkout.body.orderId;
    assert.equal((await api("GET", "/api/my/orders")).body.length, 1);
    assert.equal((await api("POST", "/api/simulator/pay", { orderId, transactionStatus: "nonsense" })).status, 400);
    assert.equal((await api("POST", "/api/simulator/pay", { orderId, transactionStatus: "settlement", paymentType: "qris" })).status, 200);
    let order;
    for (let i = 0; i < 60; i++) {
      order = (await api("GET", `/api/orders/${orderId}`)).body;
      if (order.status === "ticket_minted") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(order.status, "ticket_minted");
    assert.equal(order.tickets.length, 2);
    assert.equal((await api("POST", "/api/simulator/pay", { orderId })).status, 409);
    await api("POST", "/api/auth/logout", {});
    assert.equal((await api("GET", `/api/orders/${orderId}`)).status, 401);
    assert.equal((await api("POST", "/api/auth/login", { email: form.email, password: "wrong" })).status, 401);
    assert.equal((await api("POST", "/api/auth/login", { email: form.email.toUpperCase(), password: form.password })).status, 200);
    assert.equal((await api("GET", `/api/users/${user.body.id}/tickets`)).body.length, 2);
    const resale = await api("POST", "/api/resale/checkout", { userId: user.body.id, tokenId: listings[0].token_id });
    assert.equal(resale.status, 201);
    await api("POST", "/api/simulator/pay", { orderId: resale.body.orderId, transactionStatus: "settlement" });
    let resaleOrder;
    for (let i = 0; i < 60; i++) {
      resaleOrder = (await api("GET", `/api/orders/${resale.body.orderId}`)).body;
      if (resaleOrder.status === "ticket_transferred") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(resaleOrder.status, "ticket_transferred");
    const qr = (await api("GET", `/api/tickets/${listings[0].token_id}/qr?userId=${user.body.id}`)).body.qr;
    assert.equal((await api("POST", "/api/gate/checkin", { qr })).status, 200);
    assert.equal((await api("POST", "/api/gate/checkin", { qr })).status, 409);
    await api("POST", "/api/users", { ...form, email: "other@student.ub.ac.id", nim: "987654321" });
    assert.equal((await api("GET", `/api/orders/${orderId}`)).status, 403);
    assert.equal((await api("GET", `/api/users/${user.body.id}/tickets`)).status, 403);
    require("../src/seed-account").sampleAccount(running.db, running.cfg);
    const sample = await api("POST", "/api/auth/login", { email: "nadia@student.ub.ac.id", password: "TiketAman123" }, false);
    await api("POST", "/api/examples/account", {});
    assert.equal(sample.status, 200);
    assert.equal(sample.body.name, "Nadia Putri");
    assert.equal((await api("GET", "/api/my/orders")).body.length, 7);
    const samples = (await api("GET", `/api/users/${sample.body.id}/tickets`)).body;
    assert.equal(samples.length, 4);
    assert.deepEqual(samples.map((t) => t.status).sort(), ["active", "active", "listed", "used"]);
    await api("POST", "/api/examples/account", {});
    assert.equal((await api("GET", "/api/my/orders")).body.length, 7);
    assert.equal((await api("GET", `/api/users/${sample.body.id}/tickets`)).body.length, 4);
  } finally {
    if (running) {
      running.worker.stop();
      await new Promise((r) => running.server.close(r));
      running.db.close();
    }
    if (node) node.kill();
  }
});
