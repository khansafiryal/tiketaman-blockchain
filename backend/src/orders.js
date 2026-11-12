const crypto = require("crypto");
const { tx } = require("./db");

/** State machine status pesanan. Transisi di luar tabel ini ditolak. */
const TRANSITIONS = {
  pending: ["paid", "failed", "expired"],
  paid: ["minting"],
  minting: ["ticket_minted", "ticket_transferred", "mint_failed"],
  mint_failed: ["minting", "refund_pending"],
  refund_pending: ["refunded"],
  ticket_minted: [],
  ticket_transferred: [],
  failed: [],
  expired: [],
  refunded: [],
};
const ACTIVE_STATUSES = ["pending", "paid", "minting", "mint_failed", "ticket_minted", "ticket_transferred"];

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function canTransition(from, to) { return (TRANSITIONS[from] || []).includes(to); }

/** Transisi atomik: hanya berhasil bila status saat ini sesuai (compare-and-set). */
function transition(db, orderId, from, to, fields = {}) {
  if (!canTransition(from, to)) throw new Error(`Transisi ${from} -> ${to} tidak diizinkan`);
  const sets = ["status = ?", "updated_at = datetime('now')"];
  const vals = [to];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  const r = db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE order_id = ? AND status = ?`).run(...vals, orderId, from);
  return r.changes === 1;
}

function newOrderId(prefix, eventId) {
  return `${prefix}-${eventId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

/** Jumlah tiket yang sedang/sudah dimiliki satu identitas untuk satu event (kuota per identitas). */
function identityUsage(db, userId, eventId) {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  const pendingOrPaid = db.prepare(
    `SELECT COALESCE(SUM(quantity),0) n FROM orders WHERE user_id = ? AND event_id = ? AND status IN (${placeholders})
       AND status NOT IN ('ticket_minted','ticket_transferred')`
  ).get(userId, eventId, ...ACTIVE_STATUSES).n;
  const owned = db.prepare(`SELECT COUNT(*) n FROM tickets WHERE owner_user_id = ? AND event_id = ?`).get(userId, eventId).n;
  return pendingOrPaid + owned;
}

function eventSoldOrReserved(db, eventId) {
  const placeholders = ACTIVE_STATUSES.map(() => "?").join(",");
  return db.prepare(
    `SELECT COALESCE(SUM(quantity),0) n FROM orders WHERE event_id = ? AND kind = 'primary' AND status IN (${placeholders})`
  ).get(eventId, ...ACTIVE_STATUSES).n;
}

function audit(db, actor, action, detail) {
  db.prepare(`INSERT INTO audit_log (actor, action, detail) VALUES (?,?,?)`).run(actor, action, JSON.stringify(detail));
}

module.exports = { TRANSITIONS, ACTIVE_STATUSES, HttpError, canTransition, transition, newOrderId, identityUsage, eventSoldOrReserved, audit, tx };
