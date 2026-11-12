/**
 * Estimasi biaya pemrosesan (MDR) per metode pembayaran untuk laporan rekonsiliasi.
 * Sumber tarif: halaman harga publik Midtrans (VA Rp4.000; QRIS 0,7%; GoPay/ShopeePay 2%)
 * dan kebijakan BI per 1 Oktober 2026 (MDR QRIS 0% untuk transaksi <= Rp100.000).
 * Angka ini asumsi prototipe dan wajib dicocokkan dengan kontrak merchant sebenarnya.
 */
function estimateMdr(paymentType, gross) {
  switch (paymentType) {
    case "bank_transfer":
    case "echannel":
    case "permata": return 4000;
    case "qris": return gross <= 100_000 ? 0 : Math.round(gross * 0.007);
    case "gopay":
    case "shopeepay": return Math.round(gross * 0.02);
    default: return Math.round(gross * 0.02);
  }
}

module.exports = { estimateMdr };
