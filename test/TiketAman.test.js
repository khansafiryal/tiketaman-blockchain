const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const EVENT_ID = 1n;
const FACE = 100_000n;     // Rp100.000
const CAP_BPS = 11_000;    // 110%
const ORG_SHARE = 5_000;   // 50% dari selisih harga
const MAX_PER_ADDR = 4;
const ref = (s) => ethers.id(s); // keccak256 dari order_id

async function deployFixture() {
  const [admin, operator, organizer, gate, alice, bob, carol, attacker] = await ethers.getSigners();
  const TiketAman = await ethers.getContractFactory("TiketAman");
  const c = await TiketAman.deploy(admin.address, operator.address);
  await c.waitForDeployment();
  await c.connect(admin).grantRole(await c.ORGANIZER_ROLE(), organizer.address);
  await c.connect(admin).grantRole(await c.GATE_ROLE(), gate.address);
  await c.connect(organizer).createEvent(EVENT_ID, FACE, 10, CAP_BPS, ORG_SHARE, MAX_PER_ADDR);
  return { c, admin, operator, organizer, gate, alice, bob, carol, attacker };
}

async function mintedFixture() {
  const f = await deployFixture();
  await f.c.connect(f.operator).mintTicket(EVENT_ID, f.alice.address, ref("ORD-1"));
  return { ...f, tokenId: 1n };
}

describe("TiketAman", function () {
  describe("Pembuatan event", function () {
    it("menyimpan konfigurasi event dan batas harga yang dikunci", async function () {
      const { c } = await loadFixture(deployFixture);
      const ev = await c.getEventInfo(EVENT_ID);
      expect(ev.faceValue).to.equal(FACE);
      expect(ev.maxResaleBps).to.equal(CAP_BPS);
      expect(ev.maxPerAddress).to.equal(MAX_PER_ADDR);
    });

    it("menolak konfigurasi batas resale di luar 100%-150%", async function () {
      const { c, organizer } = await loadFixture(deployFixture);
      await expect(c.connect(organizer).createEvent(2, FACE, 10, 9_000, 0, 4))
        .to.be.revertedWithCustomError(c, "InvalidConfig");
      await expect(c.connect(organizer).createEvent(2, FACE, 10, 20_000, 0, 4))
        .to.be.revertedWithCustomError(c, "InvalidConfig");
    });

    it("menolak pembuatan event oleh akun tanpa ORGANIZER_ROLE", async function () {
      const { c, attacker } = await loadFixture(deployFixture);
      await expect(c.connect(attacker).createEvent(3, FACE, 10, CAP_BPS, 0, 4))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });
  });

  describe("mintTicket", function () {
    it("operator dapat mint setelah pembayaran terverifikasi", async function () {
      const { c, operator, alice } = await loadFixture(deployFixture);
      await expect(c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("ORD-1")))
        .to.emit(c, "TicketMinted").withArgs(1n, EVENT_ID, alice.address, ref("ORD-1"));
      expect(await c.ownerOf(1n)).to.equal(alice.address);
      expect(await c.holdings(EVENT_ID, alice.address)).to.equal(1n);
    });

    it("[UJI UTAMA 1] mint oleh pihak tidak berwenang ditolak", async function () {
      const { c, attacker } = await loadFixture(deployFixture);
      await expect(c.connect(attacker).mintTicket(EVENT_ID, attacker.address, ref("FAKE")))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });

    it("orderRef yang sama tidak dapat menghasilkan token ganda (idempotensi)", async function () {
      const { c, operator, alice } = await loadFixture(deployFixture);
      await c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("ORD-1"));
      await expect(c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("ORD-1")))
        .to.be.revertedWithCustomError(c, "OrderAlreadyProcessed");
    });

    it("membatasi maksimal 4 tiket per alamat per event", async function () {
      const { c, operator, alice } = await loadFixture(deployFixture);
      for (let i = 1; i <= 4; i++) await c.connect(operator).mintTicket(EVENT_ID, alice.address, ref(`O-${i}`));
      await expect(c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("O-5")))
        .to.be.revertedWithCustomError(c, "PurchaseLimitExceeded");
    });

    it("menolak mint ketika kuota tiket event habis", async function () {
      const { c, operator, organizer, alice, bob } = await loadFixture(deployFixture);
      await c.connect(organizer).createEvent(9, FACE, 2, CAP_BPS, 0, 4);
      await c.connect(operator).mintTicket(9, alice.address, ref("S-1"));
      await c.connect(operator).mintTicket(9, bob.address, ref("S-2"));
      await expect(c.connect(operator).mintTicket(9, bob.address, ref("S-3")))
        .to.be.revertedWithCustomError(c, "SoldOut");
    });
  });

  describe("Pembatasan transfer", function () {
    it("transferFrom langsung antar-wallet ditolak", async function () {
      const { c, alice, bob, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(alice).transferFrom(alice.address, bob.address, tokenId))
        .to.be.revertedWithCustomError(c, "TransferDisabled");
    });

    it("safeTransferFrom juga ditolak walaupun sudah di-approve", async function () {
      const { c, alice, bob, tokenId } = await loadFixture(mintedFixture);
      await c.connect(alice).approve(bob.address, tokenId);
      await expect(c.connect(bob)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, tokenId))
        .to.be.revertedWithCustomError(c, "TransferDisabled");
    });
  });

  describe("Penjualan ulang resmi", function () {
    it("[UJI UTAMA 2] resale di atas batas 110% ditolak", async function () {
      const { c, alice, tokenId } = await loadFixture(mintedFixture);
      expect(await c.resaleCap(tokenId)).to.equal(110_000n);
      await expect(c.connect(alice).listForResale(tokenId, 110_001n))
        .to.be.revertedWithCustomError(c, "PriceAboveCap").withArgs(110_001n, 110_000n);
    });

    it("resale tepat di batas diterima, kepemilikan pindah, dan bagian penyelenggara tercatat", async function () {
      const { c, operator, alice, bob, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(alice).listForResale(tokenId, 110_000n)).to.emit(c, "TicketListed");
      await expect(c.connect(operator).executeResale(tokenId, bob.address, ref("RS-1")))
        .to.emit(c, "ResaleExecuted").withArgs(tokenId, alice.address, bob.address, 110_000n, 5_000n, ref("RS-1"));
      expect(await c.ownerOf(tokenId)).to.equal(bob.address);
      expect(await c.holdings(EVENT_ID, alice.address)).to.equal(0n);
      expect(await c.holdings(EVENT_ID, bob.address)).to.equal(1n);
    });

    it("batas harga selalu dihitung dari harga nominal, bukan harga resale terakhir", async function () {
      const { c, operator, alice, bob, tokenId } = await loadFixture(mintedFixture);
      await c.connect(alice).listForResale(tokenId, 110_000n);
      await c.connect(operator).executeResale(tokenId, bob.address, ref("RS-1"));
      await expect(c.connect(bob).listForResale(tokenId, 121_000n))
        .to.be.revertedWithCustomError(c, "PriceAboveCap");
    });

    it("operator boleh memasang listing atas nama wallet custodial, pihak lain tidak", async function () {
      const { c, operator, attacker, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(operator).listForResale(tokenId, 100_000n)).to.emit(c, "TicketListed");
      await expect(c.connect(attacker).listForResale(tokenId, 100_000n))
        .to.be.revertedWithCustomError(c, "NotTicketHolder");
    });

    it("executeResale ditolak untuk tiket yang tidak dipasang untuk dijual", async function () {
      const { c, operator, bob, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(operator).executeResale(tokenId, bob.address, ref("RS-X")))
        .to.be.revertedWithCustomError(c, "NotListed");
    });

    it("pembeli resale tetap terkena batas 4 tiket per alamat", async function () {
      const { c, operator, alice, bob } = await loadFixture(deployFixture);
      for (let i = 1; i <= 4; i++) await c.connect(operator).mintTicket(EVENT_ID, bob.address, ref(`B-${i}`));
      await c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("A-1"));
      await c.connect(alice).listForResale(5n, 100_000n);
      await expect(c.connect(operator).executeResale(5n, bob.address, ref("RS-B")))
        .to.be.revertedWithCustomError(c, "PurchaseLimitExceeded");
    });

    it("pemilik dapat membatalkan listing", async function () {
      const { c, alice, tokenId } = await loadFixture(mintedFixture);
      await c.connect(alice).listForResale(tokenId, 105_000n);
      await expect(c.connect(alice).cancelListing(tokenId)).to.emit(c, "ListingCancelled");
      expect(await c.listings(tokenId)).to.equal(0n);
    });
  });

  describe("Check-in", function () {
    it("[UJI UTAMA 3] check-in ganda ditolak", async function () {
      const { c, gate, alice, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(gate).checkIn(tokenId, alice.address)).to.emit(c, "CheckedIn");
      expect((await c.getTicket(tokenId)).used).to.equal(true);
      await expect(c.connect(gate).checkIn(tokenId, alice.address))
        .to.be.revertedWithCustomError(c, "TicketAlreadyUsed");
    });

    it("check-in ditolak bila pemegang yang ditunjukkan bukan pemilik token", async function () {
      const { c, gate, bob, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(gate).checkIn(tokenId, bob.address))
        .to.be.revertedWithCustomError(c, "NotTicketHolder");
    });

    it("hanya GATE_ROLE yang dapat melakukan check-in", async function () {
      const { c, attacker, alice, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(attacker).checkIn(tokenId, alice.address))
        .to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });

    it("tiket yang sudah dipakai tidak dapat dijual ulang", async function () {
      const { c, gate, alice, tokenId } = await loadFixture(mintedFixture);
      await c.connect(gate).checkIn(tokenId, alice.address);
      await expect(c.connect(alice).listForResale(tokenId, 100_000n))
        .to.be.revertedWithCustomError(c, "TicketAlreadyUsed");
    });
  });

  describe("Darurat", function () {
    it("admin dapat menghentikan sementara (pause) mint", async function () {
      const { c, admin, operator, alice } = await loadFixture(deployFixture);
      await c.connect(admin).pause();
      await expect(c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("P-1")))
        .to.be.revertedWithCustomError(c, "EnforcedPause");
      await c.connect(admin).unpause();
      await expect(c.connect(operator).mintTicket(EVENT_ID, alice.address, ref("P-1"))).to.emit(c, "TicketMinted");
    });

    it("akun non-admin tidak dapat melakukan pause", async function () {
      const { c, attacker } = await loadFixture(deployFixture);
      await expect(c.connect(attacker).pause()).to.be.revertedWithCustomError(c, "AccessControlUnauthorizedAccount");
    });
  });

  describe("Validasi tambahan", function () {
    it("menolak event ganda, event tidak dikenal, dan bagian penyelenggara > 100%", async function () {
      const { c, organizer, operator, alice } = await loadFixture(deployFixture);
      await expect(c.connect(organizer).createEvent(EVENT_ID, FACE, 10, CAP_BPS, 0, 4))
        .to.be.revertedWithCustomError(c, "EventAlreadyExists");
      await expect(c.connect(organizer).createEvent(7, FACE, 10, CAP_BPS, 10_001, 4))
        .to.be.revertedWithCustomError(c, "InvalidConfig");
      await expect(c.connect(organizer).createEvent(7, 0, 10, CAP_BPS, 0, 4))
        .to.be.revertedWithCustomError(c, "InvalidConfig");
      await expect(c.connect(operator).mintTicket(99, alice.address, ref("X")))
        .to.be.revertedWithCustomError(c, "EventNotFound");
      await expect(c.getEventInfo(99)).to.be.revertedWithCustomError(c, "EventNotFound");
    });

    it("menolak listing dengan harga nol dan pembatalan listing yang tidak ada", async function () {
      const { c, alice, attacker, tokenId } = await loadFixture(mintedFixture);
      await expect(c.connect(alice).listForResale(tokenId, 0n)).to.be.revertedWithCustomError(c, "PriceAboveCap");
      await expect(c.connect(alice).cancelListing(tokenId)).to.be.revertedWithCustomError(c, "NotListed");
      await c.connect(alice).listForResale(tokenId, 100_000n);
      await expect(c.connect(attacker).cancelListing(tokenId)).to.be.revertedWithCustomError(c, "NotTicketHolder");
    });

    it("orderRef resale yang sudah dipakai ditolak", async function () {
      const { c, operator, alice, bob, tokenId } = await loadFixture(mintedFixture);
      await c.connect(alice).listForResale(tokenId, 100_000n);
      await expect(c.connect(operator).executeResale(tokenId, bob.address, ref("ORD-1")))
        .to.be.revertedWithCustomError(c, "OrderAlreadyProcessed");
    });

    it("resale pada harga nominal tidak menghasilkan bagian penyelenggara", async function () {
      const { c, operator, alice, bob, tokenId } = await loadFixture(mintedFixture);
      await c.connect(alice).listForResale(tokenId, 100_000n);
      await expect(c.connect(operator).executeResale(tokenId, bob.address, ref("RS-0")))
        .to.emit(c, "ResaleExecuted").withArgs(tokenId, alice.address, bob.address, 100_000n, 0n, ref("RS-0"));
    });

    it("mendukung antarmuka ERC-721 dan AccessControl", async function () {
      const { c } = await loadFixture(deployFixture);
      expect(await c.supportsInterface("0x80ac58cd")).to.equal(true); // ERC-721
      expect(await c.supportsInterface("0x7965db0b")).to.equal(true); // AccessControl
    });
  });
});
