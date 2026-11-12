const { loadConfig } = require("./config");
const { openDb } = require("./db");
const { createChain } = require("./chain");
const { createWorker } = require("./worker");
const { createApp, seedEvent } = require("./app");

function start(env = process.env) {
  const cfg = loadConfig(env);
  const db = openDb(cfg.dbPath);
  const chain = createChain(cfg.chain);
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  const worker = createWorker({ db, getChain: () => chain, cfg, log });
  const app = createApp({ cfg, db, getChain: () => chain, worker, log });
  for (const event of require("./events")) {
    if (!db.prepare("SELECT 1 FROM events WHERE id = ?").get(event.id)) seedEvent(db, event);
  }
  worker.start();
  const server = app.listen(cfg.port, () => log(`TiketAman backend berjalan di http://localhost:${cfg.port} (mode ${cfg.paymentMode})`));
  return { app, server, db, worker, cfg };
}

if (require.main === module) start();
module.exports = { start };
