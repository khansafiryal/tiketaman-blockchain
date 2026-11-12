const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  identity_hash   TEXT NOT NULL UNIQUE,      -- SHA-256(NIM + salt); NIM mentah tidak disimpan
  wallet_address  TEXT NOT NULL UNIQUE,
  wallet_key_enc  TEXT NOT NULL,             -- kunci privat terenkripsi AES-256-GCM
  consent_at      TEXT NOT NULL,             -- persetujuan pemrosesan data (UU PDP)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id                  INTEGER PRIMARY KEY,   -- sama dengan eventId di smart contract
  name                TEXT NOT NULL,
  venue               TEXT NOT NULL,
  starts_at           TEXT NOT NULL,
  face_value          INTEGER NOT NULL,
  service_fee         INTEGER NOT NULL,
  supply              INTEGER NOT NULL,
  max_resale_bps      INTEGER NOT NULL,
  organizer_share_bps INTEGER NOT NULL,
  max_per_identity    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  order_id                TEXT PRIMARY KEY,
  kind                    TEXT NOT NULL CHECK (kind IN ('primary','resale')),
  user_id                 INTEGER NOT NULL REFERENCES users(id),
  event_id                INTEGER NOT NULL REFERENCES events(id),
  quantity                INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 4),
  unit_price              INTEGER NOT NULL,
  service_fee             INTEGER NOT NULL,
  gross_amount            INTEGER NOT NULL,
  resale_token_id         INTEGER,
  status                  TEXT NOT NULL,
  payment_type            TEXT,
  midtrans_transaction_id TEXT,
  snap_token              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at                 TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  token_id       INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id),
  order_id       TEXT NOT NULL REFERENCES orders(order_id),
  order_index    INTEGER NOT NULL,
  owner_user_id  INTEGER NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL CHECK (status IN ('active','listed','used')),
  list_price     INTEGER,
  mint_tx        TEXT NOT NULL,
  last_tx        TEXT NOT NULL,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, order_index)
);
CREATE TABLE IF NOT EXISTS payment_notifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           TEXT,
  transaction_status TEXT,
  status_code        TEXT,
  gross_amount       TEXT,
  payment_type       TEXT,
  signature_valid    INTEGER NOT NULL,
  result             TEXT NOT NULL,
  received_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chain_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    TEXT NOT NULL UNIQUE REFERENCES orders(order_id),  -- idempotensi di database
  action      TEXT NOT NULL CHECK (action IN ('mint','resale')),
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "password_hash"))
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  return db;
}

/** Menjalankan fn di dalam transaksi SQLite (BEGIN IMMEDIATE agar aman dari race). */
function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

module.exports = { openDb, tx };
