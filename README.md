# TiketAman

TiketAman adalah aplikasi tiket event berbasis blockchain dengan pembatasan penjualan ulang untuk mengurangi praktik percaloan. Setiap tiket direpresentasikan sebagai token ERC-721 dengan kepemilikan dan status penggunaan yang tercatat pada smart contract.

## Fitur aplikasi

- Halaman awal dengan kategori event, pendaftaran, dan login menggunakan email serta kata sandi.
- Katalog 8 event dengan jadwal, lokasi, harga, dan kuota tiket.
- Pemesanan tiket dengan rincian harga serta biaya layanan.
- Pembayaran melalui Virtual Account, QRIS, GoPay, dan ShopeePay dalam lingkungan sandbox atau simulator lokal.
- Pesanan Saya untuk riwayat transaksi dan status pembayaran.
- Tiket Saya untuk tiket yang telah terbit, QR masuk, dan penjualan ulang.
- Pasar resale dengan batas harga maksimal 110% dari harga nominal pada konfigurasi event contoh.
- Check-in menggunakan QR bertanda tangan dengan masa berlaku 60 detik dan pencegahan penggunaan tiket ganda.
- Rekonsiliasi pesanan, pembayaran, dan pencatatan blockchain.

## Teknologi

| Bagian | Teknologi |
|---|---|
| Antarmuka | HTML5, CSS3, JavaScript |
| Server | Node.js, Express |
| Database | SQLite melalui modul bawaan `node:sqlite` |
| Smart contract | Solidity 0.8.24, ERC-721, OpenZeppelin Contracts v5 |
| Jaringan blockchain | Hardhat Network lokal dan Ethereum Sepolia |
| Penghubung blockchain | ethers.js v6 |
| Pembayaran | Midtrans Snap sandbox dan simulator pembayaran lokal |
| QR | Paket `qrcode`, tanda tangan HMAC-SHA256 |
| Pengujian | Hardhat, Mocha, Chai, Node.js Test Runner, Solidity Coverage |

## Keamanan dan aturan tiket

Kata sandi disimpan sebagai hash scrypt dengan salt. Login menggunakan cookie sesi HttpOnly dengan SameSite Strict. NIM disimpan sebagai hash SHA-256, sedangkan kunci privat wallet custodial dienkripsi menggunakan AES-256-GCM.

Smart contract membatasi pencetakan tiket kepada operator, menolak referensi pesanan ganda, dan membatasi kepemilikan maksimal 4 tiket per alamat per event pada konfigurasi contoh. Transfer langsung antar-wallet dinonaktifkan; perpindahan kepemilikan berlangsung melalui resale resmi. Tiket yang telah digunakan tidak dapat dijual kembali.

Notifikasi pembayaran diverifikasi menggunakan signature SHA-512 dan pemeriksaan nominal. Pencetakan serta perpindahan tiket diproses melalui antrean dengan mekanisme retry dan idempotensi.

## Data contoh

Demo lokal memiliki 8 event, 24 tiket resale dari penjual contoh, serta akun Nadia Putri dengan 7 pesanan dan 4 tiket. Akun baru juga mendapat data contoh pada mode lokal. Navigasi aplikasi tersedia setelah login; pendaftaran berhasil langsung membuat sesi aktif.

Database demo secara bawaan berada dalam memori. Akun, pesanan, dan perubahan tiket hilang ketika proses demo dihentikan. Sesi login berlaku maksimal 24 jam dan berakhir ketika server dimulai ulang. Pembayaran lokal tidak memindahkan uang sungguhan.

## Menjalankan demo

Prasyarat: Node.js yang menyediakan modul `node:sqlite`, npm, dan dependensi proyek.

Di PowerShell Windows:

```powershell
npm.cmd install
npm.cmd run compile
npm.cmd run demo
```

Setelah muncul pesan **Demo siap**, buka **http://localhost:3000**. Terminal tetap berjalan selama aplikasi digunakan.

| Akun contoh | Nilai |
|---|---|
| Email | nadia@student.ub.ac.id |
| Kata sandi | TiketAman123 |

Alur demo: masuk atau daftar, pilih event, konfirmasi pesanan, pilih metode pembayaran, konfirmasi melalui layar bank/dompet, lalu cek status. Tiket yang terbit tersedia di Tiket Saya. Pasar Resale menyediakan tiket contoh yang dapat dibeli. Pada Check-in, tiket dapat dipilih untuk mengisi QR sebelum verifikasi.

Demo dihentikan dengan **Ctrl+C**. Setelah perubahan kode, jalankan kembali `npm.cmd run demo` dan muat ulang browser dengan **Ctrl+F5**.
