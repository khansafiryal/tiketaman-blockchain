const crypto = require("crypto");
const { ethers } = require("ethers");

/** Wallet custodial: dibuat otomatis per akun, kunci privat dienkripsi AES-256-GCM. */
function createCustodialWallet(encKeyHex) {
  const w = ethers.Wallet.createRandom();
  return { address: w.address, encrypted: encrypt(w.privateKey, encKeyHex) };
}

function encrypt(plain, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("WALLET_ENCRYPTION_KEY harus 32 byte (64 karakter hex)");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("hex"), c.getAuthTag().toString("hex"), ct.toString("hex")].join(":");
}

function decrypt(blob, keyHex) {
  const [iv, tag, ct] = blob.split(":").map((h) => Buffer.from(h, "hex"));
  const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

module.exports = { createCustodialWallet, encrypt, decrypt };
