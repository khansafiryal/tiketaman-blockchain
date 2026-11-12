const crypto = require("crypto");
const { HttpError } = require("./orders");
const passwordHash = (password) => {
  if (typeof password !== "string" || password.length < 8 || password.length > 128)
    throw new HttpError(400, "Kata sandi harus 8–128 karakter");
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
};
function installAuth(app, db, cfg, limiter) {
  const sessions = new Map();
  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });
  const login = (res, u) => {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: u.id, expires: Date.now() + 86400000 });
    res.cookie("ta_session", token, { httpOnly: true, sameSite: "strict", maxAge: 86400000, secure: false });
  };
  app.use((req, res, next) => {
    const token = /(?:^|;\s*)ta_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const session = sessions.get(token);
    if (session && session.expires > Date.now()) req.userId = session.userId;
    else if (token) sessions.delete(token);
    req.sessionToken = token;
    next();
  });
  app.get("/api/auth/me", (req, res) => {
    const u = req.userId && db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
    res.json(u ? publicUser(u) : null);
  });
  app.post("/api/auth/login", limiter, (req, res) => {
    const { email, password } = req.body || {};
    const u = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
    const [salt, hash] = (u?.password_hash || "").split(":");
    const candidate = crypto.scryptSync(typeof password === "string" ? password.slice(0, 128) : "", salt || "invalid", 64);
    if (!hash || !crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex")))
      throw new HttpError(401, "Email atau kata sandi salah. Akun demo lama tanpa kata sandi perlu didaftarkan kembali setelah demo dimulai ulang.");
    login(res, u); res.json(publicUser(u));
  });
  app.post("/api/auth/logout", (req, res) => {
    sessions.delete(req.sessionToken); res.clearCookie("ta_session"); res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    if (!cfg.requireAuth) return next();
    if (["/users", "/health", "/events", "/webhooks/midtrans"].includes(req.path) &&
        !(req.path === "/users" && req.method !== "POST")) return next();
    if (!req.userId) throw new HttpError(401, "Masuk terlebih dahulu untuk melanjutkan");
    if (req.path.startsWith("/admin") || (!cfg.demoTools && (req.path.startsWith("/gate") || req.path.startsWith("/reports"))))
      throw new HttpError(403, "Fitur ini khusus petugas demo, bukan akun pembeli");
    if (req.path === "/users" || /^\/users\/\d+$/.test(req.path)) throw new HttpError(403, "Daftar akun bersifat pribadi");
    const ownerPath = /^\/users\/(\d+)\/tickets$/.exec(req.path);
    if (ownerPath && Number(ownerPath[1]) !== req.userId) throw new HttpError(403, "Bukan akun Anda");
    if (req.body && "userId" in req.body) req.body.userId = req.userId;
    if (req.path.endsWith("/qr") && Number(req.query.userId) !== req.userId) throw new HttpError(403, "Bukan akun Anda");
    const orderId = /^\/orders\/([^/]+)$/.exec(req.path)?.[1] || (req.path === "/simulator/pay" && req.body?.orderId);
    if (orderId) {
      const order = db.prepare("SELECT user_id FROM orders WHERE order_id = ?").get(orderId);
      if (order && order.user_id !== req.userId) throw new HttpError(403, "Bukan pesanan Anda");
    }
    next();
  });
  return { login };
}
module.exports = { installAuth, passwordHash };
