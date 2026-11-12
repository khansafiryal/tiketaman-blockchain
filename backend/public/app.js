const $ = (s) => document.querySelector(s);
const rp = (n) => "Rp" + Number(n || 0).toLocaleString("id-ID");
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
let currentUser = null;
const me = () => currentUser?.id;
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function requireLogin() {
  if (currentUser) return true;
  $("#loginErr").textContent = "Masuk atau daftar terlebih dahulu untuk melanjutkan.";
  $("#loginDlg").showModal(); return false;
}
const STEPS = ["pending", "paid", "minting", "ticket_minted"];
const LABEL = { pending: "Menunggu bayar", paid: "Dibayar", minting: "Mencetak token", ticket_minted: "Tiket terbit",
  ticket_transferred: "Tiket dipindah", failed: "Gagal", expired: "Kedaluwarsa", mint_failed: "Mint gagal", refund_pending: "Menunggu refund" };

async function loadUsers() {
  currentUser = await api("GET", "/api/auth/me");
  const health = await api("GET", "/api/health");
  $("#welcome").classList.toggle("hidden", !!currentUser);
  $("#appShell").classList.toggle("hidden", !currentUser);
  if (health.demoTools && currentUser) await api("POST", "/api/examples/account", {});
  document.querySelectorAll('[data-tab="gate"], [data-tab="recon"]').forEach((b) => b.classList.toggle("hidden", !health.demoTools));
  $("#currentUser").textContent = currentUser ? `Hai, ${currentUser.name}` : "Belum masuk";
  $("#btnLogin").classList.toggle("hidden", !!currentUser);
  $("#btnRegister").classList.toggle("hidden", !!currentUser);
  $("#btnLogout").classList.toggle("hidden", !currentUser);
}
async function renderEvents() {
  const evs = await api("GET", "/api/events");
  window.eventCatalog = evs;
  $("#tab-events").innerHTML = `<div class="hero"><span class="badge">TEMUKAN PENGALAMAN BARU</span><h1>Rencana seru dimulai di sini.</h1><p>Musik, kreativitas, dan pengalaman pilihan untukmu.</p></div><div class="catalog">` + evs.map((e) => `
    <div class="card event">
      <div class="poster"><span class="badge" style="background:rgba(255,255,255,.18);color:#fff;width:max-content">Event pilihan &middot; #${e.id}</span><b>${escapeHtml(e.name)}</b><span>${escapeHtml(e.venue)}</span></div>
      <div>
        <div class="price">${rp(e.face_value)}</div>
        <div class="muted small">+ biaya layanan ${rp(e.service_fee)} per tiket</div>
        <div class="kv">
          <span>Jadwal</span><span>${new Date(e.starts_at).toLocaleString("id-ID", { dateStyle: "full", timeStyle: "short" })}</span>
          <span>Sisa kuota</span><span>${e.supply - e.reserved} dari ${e.supply}</span>
          <span>Aturan</span><span><span class="badge">Maks ${e.max_per_identity} tiket/identitas</span> <span class="badge">Resale maks ${rp(e.resale_cap)}</span></span>
        </div>
        <div class="row">
          <label>Jumlah tiket <select id="qty${e.id}">${[1, 2, 3, 4].map((q) => `<option>${q}</option>`).join("")}</select></label>
          <button onclick="buy(${e.id})" ${e.supply <= e.reserved ? "disabled" : ""}>${e.supply <= e.reserved ? "Tiket habis" : "Pesan tiket"}</button>
        </div>
        <div id="buyErr${e.id}" class="err"></div>
      </div>
    </div>`).join("") + "</div>";
}

let pendingCheckout;
async function buy(eventId) {
  if (!requireLogin()) return;
  const e = window.eventCatalog.find((e) => e.id === eventId);
  const quantity = Number($(`#qty${eventId}`).value);
  pendingCheckout = { userId: me(), eventId, quantity };
  $("#checkoutSummary").innerHTML = `<h4>${escapeHtml(e.name)}</h4><p>${escapeHtml(e.venue)}</p><div class="kv"><span>Tiket (${quantity} x ${rp(e.face_value)})</span><strong>${rp(quantity * e.face_value)}</strong><span>Biaya layanan</span><span>${rp(quantity * e.service_fee)}</span><span>Total pembayaran</span><strong>${rp(quantity * (e.face_value + e.service_fee))}</strong></div>`;
  $("#checkoutErr").textContent = ""; $("#checkoutDlg").showModal();
}
$("#checkoutCancel").onclick = () => $("#checkoutDlg").close();
$("#checkoutForm").onsubmit = async (ev) => {
  ev.preventDefault(); $("#checkoutSubmit").disabled = true;
  try { const r = await api("POST", "/api/checkout", pendingCheckout); location.href = r.redirectUrl; }
  catch (e) { $("#checkoutErr").textContent = e.message; $("#checkoutSubmit").disabled = false; }
};
async function renderOrders() {
  if (!currentUser) { $("#tab-orders").innerHTML = '<div class="card">Masuk untuk melihat pesanan Anda.</div>'; return; }
  const orders = await api("GET", "/api/my/orders");
  $("#tab-orders").innerHTML = '<div class="section-heading"><div><span class="eyebrow">TRANSAKSI</span><h2>Pesanan Saya</h2></div><span class="muted">Riwayat pembelian</span></div>' + (orders.length ? orders.map((o) => `<div class="card"><h3>${escapeHtml(o.event_name)}</h3><p>${o.quantity} tiket &middot; ${rp(o.gross_amount)} &middot; <span class="badge">${LABEL[o.status] || o.status}</span></p><p class="mono">${o.order_id}</p>${o.status === 'pending' ? `<button onclick="location.href='/simulator.html?order_id=${encodeURIComponent(o.order_id)}'">Lanjutkan pembayaran</button>` : `<button onclick="showOrder('${o.order_id}')">Lihat status</button>`}</div>`).join('') : '<div class="card">Belum ada pesanan. Pilih event untuk mulai memesan tiket.</div>');
}
async function showOrder(orderId) {
  const accountId = me();
  const box = $("#orderBox");
  box.classList.remove("hidden");
  const draw = (o) => {
    const failed = ["failed", "expired", "refund_pending", "mint_failed"].includes(o.status);
    const idx = STEPS.indexOf(o.status === "ticket_transferred" ? "ticket_minted" : o.status);
    box.innerHTML = `<div class="row" style="justify-content:space-between"><h3>Pesanan ${o.order_id}</h3>
        <span class="badge ${failed ? "bad" : o.status.startsWith("ticket") ? "ok" : "warn"}">${LABEL[o.status] || o.status}</span></div>
      <div class="muted small">${o.kind === "resale" ? "Pembelian resale resmi" : `${o.quantity} tiket`} &middot; total ${rp(o.gross_amount)} &middot; metode ${o.payment_type || "-"}</div>
      <div class="timeline">${STEPS.map((s, i) => `<div class="${failed && i > Math.max(idx, 0) ? "" : i <= idx ? "done" : ""} ${failed && i === 1 ? "fail" : ""}">${LABEL[s]}</div>`).join("")}</div>
      ${o.status === "pending" ? `<p>Pembayaran belum selesai. Anda bisa melanjutkannya melalui Pesanan Saya.</p>` : o.status === "ticket_minted" || o.status === "ticket_transferred" ? `<p class="okmsg">Pembayaran berhasil. Tiket Anda sudah siap.</p><button onclick="openTab('mytickets')">Buka Tiket Saya</button>` : failed ? '<p>Pesanan belum menghasilkan tiket. Silakan buat pesanan baru dari Event.</p>' : '<p>Pembayaran diterima. Tiket sedang disiapkan, tunggu sebentar.</p>'}
      ${o.tickets?.length ? `<div class="small">Token: ${o.tickets.map((t) => `#${t.token_id} <span class="mono">${t.mint_tx.slice(0, 18)}...</span>`).join(" &middot; ")}</div>` : ""}`;
    return o;
  };
  for (let i = 0; i < 60; i++) {
    if (me() !== accountId) return;
    const result = await api("GET", `/api/orders/${orderId}`);
    if (me() !== accountId) return;
    const o = draw(result);
    if (!["pending", "paid", "minting", "mint_failed"].includes(o.status)) break;
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function renderMyTickets() {
  if (!currentUser) { $("#tab-mytickets").innerHTML = '<div class="card">Masuk untuk melihat tiket Anda.</div>'; return; }
  const ts = await api("GET", `/api/users/${me()}/tickets`);
  $("#tab-mytickets").innerHTML = '<div class="section-heading"><div><span class="eyebrow">KOLEKSI TIKET</span><h2>Tiket Saya</h2></div><span class="muted">Siap untuk pengalaman berikutnya</span></div>' + (ts.length ? `<div class="grid">${ts.map((t) => `
    <div class="card ticket">
      <div class="qr" id="qr${t.token_id}">${t.status === "used" ? "Sudah dipakai" : `<button class="small" onclick="showQr(${t.token_id})">Tampilkan QR</button>`}</div>
      <div style="flex:1">
        <h3>${escapeHtml(t.event_name)}</h3>
        <div class="kv"><span>Token</span><span>#${t.token_id}</span><span>Status</span><span><span class="badge ${t.status === "used" ? "bad" : t.status === "listed" ? "warn" : "ok"}">${({active:"Siap digunakan",listed:"Dijual kembali",used:"Sudah digunakan"})[t.status]}</span></span>
        </div>
        ${t.status === "active" ? `<div class="row"><input id="price${t.token_id}" type="number" value="${t.resale_cap}" style="width:120px"><button class="small ghost" onclick="listTicket(${t.token_id})">Jual ulang</button></div>
        <div class="muted small">Harga maksimal ${rp(t.resale_cap)}</div>` : ""}
        <div id="tErr${t.token_id}" class="err"></div>
      </div>
    </div>`).join("")}</div>` : `<div class="card muted">Belum ada tiket terbit. Jika sudah memesan, periksa pembayaran di Pesanan Saya.</div>`);
}

async function showQr(tokenId) {
  const r = await api("GET", `/api/tickets/${tokenId}/qr?userId=${me()}`);
  $(`#qr${tokenId}`).innerHTML = `<img alt="QR tiket" src="/api/qr.svg?data=${encodeURIComponent(r.qr)}">`;
  $(`#tErr${tokenId}`).textContent = "Berlaku 60 detik";
  const health = await api("GET", "/api/health");
  if (health.demoTools) {
    const button = document.createElement("button"); button.className = "small ghost";
    button.textContent = "Buka di Check-in";
    button.onclick = () => { $("#qrInput").value = r.qr; $("#gateResult").textContent = ""; openTab("gate"); };
    $(`#tErr${tokenId}`).append(document.createElement("br"), button);
  }
}

async function listTicket(tokenId) {
  try {
    await api("POST", `/api/tickets/${tokenId}/list`, { userId: me(), price: Number($(`#price${tokenId}`).value) });
    renderMyTickets();
  } catch (e) { $(`#tErr${tokenId}`).textContent = e.message; }
}

async function renderResale() {
  if (!currentUser) { $("#tab-resale").innerHTML = '<div class="card">Masuk atau daftar untuk menjelajahi tiket resale.</div>'; return; }
  const ls = await api("GET", "/api/resale");
  $("#tab-resale").innerHTML = `<div class="hero"><span class="badge">PASAR RESALE RESMI</span><h1>Kesempatan kedua, pengalaman yang sama.</h1><p>${ls.length} tiket pilihan dengan harga terjaga.</p></div>` + (ls.length ? `<div class="catalog">${ls.map((l) => `<div class="card"><span class="badge">Token #${l.token_id}</span><h3>${escapeHtml(l.event_name)}</h3><p class="muted">${escapeHtml(l.venue)}<br>${new Date(l.starts_at).toLocaleString('id-ID')}</p><p class="small muted">Penjual: ${escapeHtml(l.seller_name)}</p><div class="kv"><span>Harga awal</span><span>${rp(l.face_value)}</span><span>Harga resale</span><strong>${rp(l.list_price)}</strong><span>Biaya layanan</span><span>${rp(l.service_fee)}</span><span>Total bayar</span><strong>${rp(l.list_price + l.service_fee)}</strong></div><button ${l.owner_user_id === me() || l.reserved ? 'disabled' : ''} onclick="buyResale(${l.token_id})">${l.owner_user_id === me() ? 'Tiket Anda' : l.reserved ? 'Sedang dipesan' : 'Beli tiket resale'}</button></div>`).join('')}</div>` : '<div class="card">Belum ada tiket yang dijual ulang.</div>') + '<div id="rsErr" class="err" role="alert"></div>';
}

async function buyResale(tokenId) {
  if (!requireLogin()) return;
  try { const r = await api("POST", "/api/resale/checkout", { userId: me(), tokenId }); location.href = r.redirectUrl; }
  catch (e) { $("#rsErr").textContent = e.message; }
}

async function renderRecon() {
  const { summary: s, rows } = await api("GET", "/api/reports/reconciliation?eventId=1");
  $("#tab-recon").innerHTML = `
    <div class="section-heading"><div><span class="eyebrow">RINGKASAN</span><h2>Rekonsiliasi</h2></div><span class="muted">Brawijaya Music Fest</span></div><div class="tiles">
      <div class="tile"><small>Pesanan cocok</small><b>${s.orders_matched}/${s.orders_total}</b></div>
      <div class="tile"><small>Dana masuk (gross)</small><b>${rp(s.gross_collected)}</b></div>
      <div class="tile"><small>Token on-chain</small><b>${s.tickets_onchain}</b></div>
      <div class="tile"><small>Pendapatan bersih platform</small><b>${rp(s.platform_net)}</b></div>
    </div>
    <div class="card"><h3>Rekonsiliasi pesanan &harr; pembayaran &harr; blockchain</h3>
      <table><tr><th>Order ID</th><th>Jenis</th><th>Status</th><th>Gross</th><th>Dibayar</th><th>Metode</th><th>Token on-chain</th><th>Est. MDR</th><th>Cocok</th></tr>
      ${rows.map((r) => `<tr><td class="mono">${r.order_id}</td><td>${r.kind}</td><td>${r.status}</td><td>${rp(r.gross_amount)}</td><td>${rp(r.paid_amount)}</td>
        <td>${r.payment_type || "-"}</td><td>${r.onchain_tokens}</td><td>${rp(r.mdr_estimate)}</td><td>${r.match ? '<span class="badge ok">Ya</span>' : '<span class="badge bad">Tidak</span>'}</td></tr>`).join("")}</table>
      <p class="muted small">Penyelenggara: ${rp(s.organizer_payout)} &middot; Penjual resale: ${rp(s.seller_payout)} &middot; Biaya layanan: ${rp(s.service_fee_revenue)} &middot; Komisi resale: ${rp(s.resale_commission)} &middot; Est. MDR: ${rp(s.mdr_estimate)} &middot; Kewajiban refund: ${rp(s.refund_liability)}</p>
    </div>`;
}

$("#btnCheckin").onclick = async () => {
  try {
    const r = await api("POST", "/api/gate/checkin", { qr: $("#qrInput").value.trim() });
    $("#gateResult").innerHTML = `<div class="okmsg">Masuk diizinkan: token #${r.tokenId} atas nama ${r.holder}. Tx <span class="mono">${r.txHash.slice(0, 20)}...</span></div>`;
  } catch (e) { $("#gateResult").innerHTML = `<div class="err">Ditolak: ${e.message}</div>`; }
};

$("#btnRegister").onclick = () => { $("#regErr").textContent = ""; $("#regDlg").showModal(); };
$("#regCancel").onclick = () => $("#regDlg").close();
$("#regForm").onsubmit = async (ev) => {
  ev.preventDefault();
  if (!$("#regForm").reportValidity()) return;
  const f = new FormData($("#regForm"));
  $("#regSubmit").disabled = true;
  $("#regErr").textContent = "";
  try {
    const u = await api("POST", "/api/users", { name: f.get("name"), email: f.get("email"), password: f.get("password"), nim: f.get("nim"), consent: f.get("consent") === "on" });
    
    await loadUsers(u.id);
    $("#regDlg").close();
    $("#regForm").reset();
    $("#orderBox").classList.add("hidden");
    $("#accountStatus").textContent = `Selamat datang, ${u.name}.`;
    $("#accountStatus").classList.remove("hidden");
    await openTab("events");
  } catch (e) { $("#regErr").textContent = e.message; }
  finally { $("#regSubmit").disabled = false; }
};

async function renderGate() {
  const box = $("#gateTickets"); box.replaceChildren();
  if (!currentUser) return;
  const tickets = await api("GET", `/api/users/${me()}/tickets`);
  for (const t of tickets) {
    const button = document.createElement("button"); button.className = "ghost small";
    button.textContent = `${t.event_name} #${t.token_id}`;
    button.onclick = async () => {
      try {
        const result = await api("GET", `/api/tickets/${t.token_id}/qr?userId=${me()}`);
        $("#qrInput").value = result.qr; $("#gateResult").textContent = "";
      } catch (e) { $("#gateResult").textContent = e.message; }
    };
    box.append(button);
  }
}
const TABS = { events: renderEvents, orders: renderOrders, mytickets: renderMyTickets, resale: renderResale, gate: renderGate, recon: renderRecon };
async function openTab(name) {
  if (!currentUser) return;
  if (!Object.hasOwn(TABS, name)) name = "events";
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== `tab-${name}`));
  try { await TABS[name](); }
  catch (e) { $(`#tab-${name}`).textContent = `Gagal memuat halaman: ${e.message}. Coba pilih tab ini lagi.`; }
}
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
$("#btnLogin").onclick = () => { $("#loginErr").textContent = ""; $("#loginDlg").showModal(); };
$("#loginCancel").onclick = () => $("#loginDlg").close();
$("#loginRegister").onclick = () => { $("#loginDlg").close(); $("#btnRegister").click(); };
$("#registerLogin").onclick = () => { $("#regDlg").close(); $("#btnLogin").click(); };
$("#welcomeRegister").onclick = () => $("#btnRegister").click();
$("#welcomeLogin").onclick = () => $("#btnLogin").click();
$("#loginForm").onsubmit = async (ev) => {
  ev.preventDefault(); $("#loginSubmit").disabled = true;
  try {
    await api("POST", "/api/auth/login", Object.fromEntries(new FormData($("#loginForm"))));
    await loadUsers(); $("#loginDlg").close(); $("#loginForm").reset(); await openTab("events");
  } catch (e) { $("#loginErr").textContent = e.message; }
  finally { $("#loginSubmit").disabled = false; }
};
$("#btnLogout").onclick = async () => {
  await api("POST", "/api/auth/logout", {}); await loadUsers();
  $("#orderBox").classList.add("hidden"); $("#accountStatus").classList.add("hidden"); await openTab("events");
};

(async () => {
  try { await loadUsers(); } catch (e) { $("#accountStatus").classList.remove("hidden"); $("#accountStatus").textContent = e.message; }
  const p = new URLSearchParams(location.search);
  if (!currentUser && p.get("auth") === "login") $("#btnLogin").click();

  openTab(p.get("tab") || "events");
  if (p.get("order") && currentUser) showOrder(p.get("order")).catch((e) => { $("#orderBox").textContent = e.message; });
})();
