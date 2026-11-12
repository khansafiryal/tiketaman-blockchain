const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get("order_id");
const rp = (n) => "Rp" + Number(n).toLocaleString("id-ID");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const labels = { bank_transfer: "Virtual Account", qris: "QRIS", gopay: "GoPay", shopeepay: "ShopeePay" };
let order, method = "bank_transfer", busy = false;
async function api(url, body) {
  const r = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || "Tidak dapat menghubungi server");
  return result;
}
function complete() {
  $("#methods").classList.add("hidden"); $("#instructions").classList.add("hidden");
  $("#complete").classList.remove("hidden");
  const success = ["paid", "minting", "ticket_minted", "ticket_transferred"].includes(order.status);
  $("#finalStatus").textContent = success ? "Pembayaran diterima. Tiket Anda sedang disiapkan atau sudah terbit." : "Pesanan gagal atau kedaluwarsa. Buat pesanan baru untuk membeli tiket.";
  $("#resultLink").href = `/?tab=orders&order=${encodeURIComponent(id)}`;
  document.querySelectorAll("details button").forEach((b) => b.disabled = true);
}
function instructions() {
  method = document.querySelector("input[name=m]:checked").value;
  const digits = String(id).replace(/\D/g, "").slice(-10).padStart(10, "0");
  const ref = `000 ${digits}`;
  $("#methods").classList.add("hidden"); $("#instructions").classList.remove("hidden");
  let details;
  if (method === "bank_transfer") details = `<p class="muted">Virtual Account</p><div class="payment-code mono">${ref}</div><p>Total <strong>${rp(order.gross_amount)}</strong></p>`;
  else if (method === "qris") details = `<div class="payment-qr"><img width="220" height="220" alt="QR pembayaran sandbox" src="/api/qr.svg?data=${encodeURIComponent(`TIKETAMAN-DEMO-NONPAYABLE:${id}`)}"></div><p>Total <strong>${rp(order.gross_amount)}</strong></p>`;
  else details = `<div class="wallet-brand">${labels[method]}</div><p>Total <strong>${rp(order.gross_amount)}</strong></p>`;
  $("#paymentDetails").innerHTML = details;
  $("#bankTitle").textContent = method === "bank_transfer" ? "Konfirmasi transfer" : `Bayar dengan ${labels[method]}`;
  $("#bankAmount").textContent = rp(order.gross_amount);
  $("#bankReference").textContent = method === "bank_transfer" ? `VA ${ref}` : `Pesanan ${id}`;
  $("#paymentStatus").textContent = "Menunggu pembayaran";
}
$("#continue").onclick = instructions;
$("#change").onclick = () => { $("#instructions").classList.add("hidden"); $("#methods").classList.remove("hidden"); };
$("#openBank").onclick = () => { $("#bankErr").textContent = ""; $("#bank").showModal(); };
$("#cancelBank").onclick = () => $("#bank").close();
$("#confirmBank").onclick = async () => {
  if (busy) return;
  busy = true; $("#confirmBank").disabled = true;
  try {
    await api("/api/simulator/pay", { orderId: id, transactionStatus: "settlement", paymentType: method });
    $("#bank").close(); $("#openBank").disabled = true; $("#change").disabled = true;
    $("#paymentStatus").textContent = "Pembayaran terkirim.";
  } catch (e) { $("#bankErr").textContent = e.message; }
  finally { busy = false; $("#confirmBank").disabled = false; }
};
$("#check").onclick = async () => {
  try { order = await api(`/api/orders/${encodeURIComponent(id)}`); if (order.status !== "pending") complete(); else $("#paymentStatus").textContent = "Menunggu konfirmasi pembayaran."; }
  catch (e) { $("#err").textContent = e.message; }
};
async function failPayment(status) {
  if (busy) return;
  busy = true;
  try { await api("/api/simulator/pay", { orderId: id, transactionStatus: status, paymentType: method }); order = await api(`/api/orders/${encodeURIComponent(id)}`); complete(); }
  catch (e) { $("#err").textContent = e.message; }
  finally { busy = false; }
}
(async () => {
  try {
    if (!await api("/api/auth/me")) { location.replace("/?auth=login"); return; }
    order = await api(`/api/orders/${encodeURIComponent(id)}`);
    const events = await api("/api/events"); const event = events.find((e) => e.id === order.event_id);
    $("#sum").innerHTML = `<h3>${esc(event?.name || "Tiket event")}</h3><p class="mono">${esc(id)}</p><div class="kv"><span>Jumlah</span><span>${order.quantity} tiket${order.kind === "resale" ? " resale" : ""}</span><span>Harga tiket</span><span>${rp(order.unit_price * order.quantity)}</span><span>Biaya layanan</span><span>${rp(order.service_fee * order.quantity)}</span><span>Total pembayaran</span><strong>${rp(order.gross_amount)}</strong></div>`;
    if (order.status === "pending") $("#methods").classList.remove("hidden"); else complete();
  } catch (e) { $("#err").textContent = e.message; }
})();
