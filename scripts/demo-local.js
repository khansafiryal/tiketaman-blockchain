// Menjalankan demo lengkap secara lokal: Hardhat node + deploy kontrak + backend (mode simulator).
const { startHardhatNode, deployContract } = require("../backend/test/helpers");
const { start } = require("../backend/src/server");

(async () => {
  const rpcPort = Number(process.env.RPC_PORT || 8545);
  const node = await startHardhatNode(rpcPort);
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const dep = await deployContract(rpcUrl, { catalog: true });
  console.log("Kontrak TiketAman:", dep.address);
  const running = start({
    ...process.env,
    PORT: process.env.PORT || "3000",
    PAYMENT_MODE: "simulator",
    DEMO_TOOLS: "true",
    MIDTRANS_SERVER_KEY: process.env.MIDTRANS_SERVER_KEY || "SB-Mid-server-DEMO-LOKAL",
    RPC_URL: rpcUrl,
    OPERATOR_PRIVATE_KEY: dep.operatorKey,
    GATE_PRIVATE_KEY: dep.gateKey,
    CONTRACT_ADDRESS: dep.address,
    WALLET_ENCRYPTION_KEY: process.env.WALLET_ENCRYPTION_KEY || "22".repeat(32),
    IDENTITY_SALT: process.env.IDENTITY_SALT || "demo-salt",
    QR_HMAC_SECRET: process.env.QR_HMAC_SECRET || "demo-qr-secret",
    MINT_BACKOFF_MS: "300",
  });
  const { server } = running;
  console.log("Menyiapkan 24 tiket resale contoh...");
  running.cfg.seedReady = require("../backend/src/seed-resale").seedResale(running);
  await running.cfg.seedReady;
  const { sampleAccount, seedAccount } = require("../backend/src/seed-account");
  const account = sampleAccount(running.db, running.cfg);
  await seedAccount(running.db, require("../backend/src/chain").createChain(running.cfg.chain), account.id);
  console.log("Demo siap: http://localhost:" + (process.env.PORT || "3000"));
  const stop = () => { server.close(); node.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((e) => { console.error(e); process.exit(1); });
