const crypto = require("crypto");

/**
 * Verifikasi signature notifikasi HTTP Midtrans:
 * signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
 * Perbandingan memakai timingSafeEqual agar tahan timing attack.
 */
function computeSignature({ order_id, status_code, gross_amount }, serverKey) {
  return crypto.createHash("sha512").update(`${order_id}${status_code}${gross_amount}${serverKey}`).digest("hex");
}

function verifySignature(notification, serverKey) {
  if (!notification || typeof notification.signature_key !== "string") return false;
  const expected = Buffer.from(computeSignature(notification, serverKey), "hex");
  let given;
  try { given = Buffer.from(notification.signature_key, "hex"); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Pemetaan transaction_status Midtrans ke status pesanan internal. */
function mapStatus({ transaction_status, fraud_status }) {
  switch (transaction_status) {
    case "capture": return fraud_status === "accept" ? "paid" : "pending";
    case "settlement": return "paid";
    case "pending": return "pending";
    case "deny":
    case "cancel":
    case "failure": return "failed";
    case "expire": return "expired";
    case "refund":
    case "partial_refund": return "refunded";
    default: return null;
  }
}

/** Klien Snap. Mode "sandbox" memanggil API Midtrans; mode "simulator" berjalan lokal tanpa jaringan. */
function createSnapClient(cfg) {
  const auth = "Basic " + Buffer.from(`${cfg.midtrans.serverKey}:`).toString("base64");
  return {
    async createTransaction(payload) {
      if (cfg.paymentMode === "simulator") {
        const token = "SIM-" + crypto.randomBytes(8).toString("hex");
        return { token, redirect_url: `/simulator.html?order_id=${encodeURIComponent(payload.transaction_details.order_id)}` };
      }
      const res = await fetch(cfg.midtrans.snapUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: auth },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Snap API ${res.status}: ${await res.text()}`);
      return res.json();
    },
    /** Challenge-response: menanyakan status ke Midtrans sebelum memproses (opsional). */
    async getStatus(orderId) {
      if (cfg.paymentMode === "simulator") return null;
      const res = await fetch(`${cfg.midtrans.apiUrl}/v2/${encodeURIComponent(orderId)}/status`, {
        headers: { Accept: "application/json", Authorization: auth },
      });
      return res.json();
    },
  };
}

module.exports = { computeSignature, verifySignature, mapStatus, createSnapClient };
