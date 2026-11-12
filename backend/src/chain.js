const path = require("path");
const { ethers } = require("ethers");
const artifact = require(path.join(__dirname, "..", "..", "artifacts", "contracts", "TiketAman.sol", "TiketAman.json"));

/** Adapter blockchain: server memanggil smart contract memakai akun operator dan akun gerbang. */
function createChain({ rpcUrl, operatorKey, gateKey, contractAddress }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, pollingInterval: 200 });
  const operator = new ethers.NonceManager(new ethers.Wallet(operatorKey, provider));
  const gate = new ethers.NonceManager(new ethers.Wallet(gateKey, provider));
  const contract = new ethers.Contract(contractAddress, artifact.abi, operator);
  const gateContract = contract.connect(gate);

  const parse = (rc, name) =>
    rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === name);

  return {
    contract,
    provider,
    orderRef: (orderId, index) => ethers.id(`${orderId}#${index}`),

    async mint(eventId, to, ref) {
      const rc = await (await contract.mintTicket(eventId, to, ref)).wait();
      const ev = parse(rc, "TicketMinted");
      return { tokenId: Number(ev.args.tokenId), txHash: rc.hash, gasUsed: Number(rc.gasUsed) };
    },
    async isProcessed(ref) { return contract.processedOrders(ref); },
    /** Pemulihan: bila tx mint sudah sukses tetapi server crash sebelum mencatat ke DB. */
    async findMintedByRef(eventId, ref) {
      const logs = await contract.queryFilter(contract.filters.TicketMinted(null, eventId));
      const hit = logs.find((l) => l.args.orderRef === ref);
      return hit ? { tokenId: Number(hit.args.tokenId), txHash: hit.transactionHash } : null;
    },
    async mintedEvents(eventId) {
      const logs = await contract.queryFilter(contract.filters.TicketMinted(null, eventId));
      return logs.map((l) => ({ tokenId: Number(l.args.tokenId), to: l.args.to, orderRef: l.args.orderRef, txHash: l.transactionHash }));
    },
    async resaleEvents() {
      const logs = await contract.queryFilter(contract.filters.ResaleExecuted());
      return logs.map((l) => ({ tokenId: Number(l.args.tokenId), from: l.args.from, to: l.args.to,
        price: Number(l.args.price), organizerShare: Number(l.args.organizerShare), orderRef: l.args.orderRef, txHash: l.transactionHash }));
    },
    async list(tokenId, price) {
      const rc = await (await contract.listForResale(tokenId, price)).wait();
      return { txHash: rc.hash, gasUsed: Number(rc.gasUsed) };
    },
    async executeResale(tokenId, to, ref) {
      const rc = await (await contract.executeResale(tokenId, to, ref)).wait();
      const ev = parse(rc, "ResaleExecuted");
      return { txHash: rc.hash, gasUsed: Number(rc.gasUsed), organizerShare: Number(ev.args.organizerShare) };
    },
    async checkIn(tokenId, holder) {
      const rc = await (await gateContract.checkIn(tokenId, holder)).wait();
      return { txHash: rc.hash, gasUsed: Number(rc.gasUsed) };
    },
    async ownerOf(tokenId) { return contract.ownerOf(tokenId); },
    async resaleCap(tokenId) { return Number(await contract.resaleCap(tokenId)); },
    async ticket(tokenId) { const t = await contract.getTicket(tokenId); return { eventId: Number(t.eventId), lastPrice: Number(t.lastPrice), used: t.used }; },
  };
}

/** Mengambil nama custom error dari revert agar pesan ke pengguna jelas. */
function revertName(err) {
  return err?.revert?.name || err?.info?.error?.data?.message || err?.shortMessage || err?.message;
}

module.exports = { createChain, revertName, abi: artifact.abi, bytecode: artifact.bytecode };
