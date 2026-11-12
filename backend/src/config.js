// Seluruh kunci dibaca dari environment variable (lihat .env.example). Tidak ada kunci di kode.
function required(name, env) {
  const v = env[name];
  if (!v) throw new Error(`Environment variable ${name} wajib diisi`);
  return v;
}

function loadConfig(env = process.env) {
  const cfg = {
    port: Number(env.PORT || 3000),
    requireAuth: env.REQUIRE_AUTH !== "false",
    demoTools: env.DEMO_TOOLS === "true" && (env.PAYMENT_MODE || "simulator") === "simulator",
    paymentMode: env.PAYMENT_MODE || "simulator", // "sandbox" (Midtrans Snap sandbox) | "simulator" (lokal)
    midtrans: {
      serverKey: required("MIDTRANS_SERVER_KEY", env),
      clientKey: env.MIDTRANS_CLIENT_KEY || "",
      isProduction: env.MIDTRANS_IS_PRODUCTION === "true",
      snapUrl: "https://app.sandbox.midtrans.com/snap/v1/transactions",
      apiUrl: "https://api.sandbox.midtrans.com",
      verifyStatus: env.MIDTRANS_VERIFY_STATUS === "true",
    },
    chain: {
      rpcUrl: required("RPC_URL", env),
      operatorKey: required("OPERATOR_PRIVATE_KEY", env),
      gateKey: required("GATE_PRIVATE_KEY", env),
      contractAddress: required("CONTRACT_ADDRESS", env),
      explorerBase: env.EXPLORER_BASE || "https://sepolia.etherscan.io",
    },
    walletEncKey: required("WALLET_ENCRYPTION_KEY", env), // 32 byte hex untuk AES-256-GCM
    identitySalt: required("IDENTITY_SALT", env),
    qrSecret: required("QR_HMAC_SECRET", env),
    dbPath: env.DB_PATH || ":memory:",
    campusEmailSuffix: env.CAMPUS_EMAIL_SUFFIX || ".ac.id",
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 30),
    mint: { maxAttempts: Number(env.MINT_MAX_ATTEMPTS || 3), backoffMs: Number(env.MINT_BACKOFF_MS || 2000) },
    resaleCommissionBps: Number(env.RESALE_COMMISSION_BPS || 500), // 5% dari harga resale, dipotong dari penjual
  };
  // Pengaman prototipe: aplikasi menolak berjalan dengan kunci produksi.
  if (cfg.midtrans.isProduction) throw new Error("Prototipe hanya boleh berjalan di sandbox Midtrans");
  return cfg;
}

module.exports = { loadConfig };
