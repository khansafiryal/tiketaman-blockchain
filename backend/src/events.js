// Katalog contoh dipakai bersama oleh database dan deployment kontrak.
module.exports = [
  ["Brawijaya Music Fest 2026", "Samantha Krida, Malang", "2026-12-12", 100000, "Musik"],
  ["Jazz di Taman", "Taman Krida Budaya, Malang", "2026-12-19", 85000, "Musik"],
  ["Tech & AI Summit", "Auditorium FILKOM UB, Malang", "2027-01-09", 75000, "Teknologi"],
  ["Stand Up Night", "Malang Creative Center", "2027-01-16", 60000, "Komedi"],
  ["Creative Design Workshop", "Studio Bersama, Malang", "2027-01-23", 125000, "Workshop"],
  ["Campus Basketball Finals", "GOR Pertamina UB, Malang", "2027-02-06", 45000, "Olahraga"],
  ["Indie Film Weekend", "Bioskop Kampus, Malang", "2027-02-13", 50000, "Film"],
  ["Entrepreneur Day", "Gedung Widyaloka UB, Malang", "2027-02-20", 65000, "Seminar"],
].map(([name, venue, date, faceValue, category], i) => ({ id: i + 1, name, venue,
  startsAt: `${date}T19:00:00+07:00`, faceValue, category, serviceFee: 5000,
  supply: 500, maxResaleBps: 11000, organizerShareBps: 5000, maxPerIdentity: 4 }));
