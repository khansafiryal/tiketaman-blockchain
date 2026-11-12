const { spawn } = require("child_process");
const path = require("path");
const { ethers } = require("ethers");
const { abi, bytecode } = require("../src/chain");

const MNEMONIC = "test test test test test test test test test test test junk"; // akun uji bawaan Hardhat (publik)
const hdKey = (i) => ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${i}`).privateKey;

async function startHardhatNode(port) {
  const root = path.join(__dirname, "..", "..");
  const hardhatCli = require.resolve("hardhat/internal/cli/bootstrap");
  const proc = spawn(process.execPath, [hardhatCli, "node", "--port", String(port)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => { clearTimeout(t); proc.off("error", onError); proc.off("exit", onExit); };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); reject(new Error(`hardhat node exit ${code}: ${output}`)); };
    const t = setTimeout(() => {
      cleanup();
      proc.kill();
      reject(new Error(`hardhat node timeout: ${output}`));
    }, 60_000);
    proc.on("error", onError);
    proc.on("exit", onExit);
    proc.stderr.on("data", (d) => { output = (output + d).slice(-4000); });
    proc.stdout.on("data", (d) => {
      output = (output + d).slice(-4000);
      if (output.includes("Started HTTP")) { cleanup(); resolve(); }
    });
  });
  return proc;
}

async function deployContract(rpcUrl, { faceValue = 100_000, supply = 500, capBps = 11_000, orgShareBps = 5_000, maxPerAddr = 4, catalog = false } = {}) {
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, pollingInterval: 200 });
  const admin = new ethers.NonceManager(new ethers.Wallet(hdKey(0), provider));
  const operator = new ethers.Wallet(hdKey(1));
  const gate = new ethers.Wallet(hdKey(2));
  const factory = new ethers.ContractFactory(abi, bytecode, admin);
  const c = await factory.deploy(await admin.getAddress(), operator.address);
  await c.waitForDeployment();
  await (await c.grantRole(await c.ORGANIZER_ROLE(), await admin.getAddress())).wait();
  await (await c.grantRole(await c.GATE_ROLE(), gate.address)).wait();
  await (await c.createEvent(1, faceValue, supply, capBps, orgShareBps, maxPerAddr)).wait();
  if (catalog) for (const e of require("../src/events").slice(1)) {
    await (await c.createEvent(e.id, e.faceValue, e.supply, e.maxResaleBps, e.organizerShareBps, e.maxPerIdentity)).wait();
  }
  return { address: await c.getAddress(), operatorKey: hdKey(1), gateKey: hdKey(2), adminKey: hdKey(0) };
}

module.exports = { startHardhatNode, deployContract, hdKey };
