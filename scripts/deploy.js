// Deploy TiketAman ke jaringan yang dipilih (localhost / sepolia) lalu membuat event demo.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const operator = process.env.OPERATOR_ADDRESS || deployer.address;
  const gate = process.env.GATE_ADDRESS || deployer.address;

  const Factory = await ethers.getContractFactory("TiketAman");
  const c = await Factory.deploy(deployer.address, operator);
  await c.waitForDeployment();
  const address = await c.getAddress();

  await (await c.grantRole(await c.ORGANIZER_ROLE(), deployer.address)).wait();
  await (await c.grantRole(await c.GATE_ROLE(), gate)).wait();
  // Event demo: Rp100.000, 500 tiket, batas resale 110%, 50% selisih untuk penyelenggara, 4 tiket/alamat
  for (const e of require("../backend/src/events")) {
    await (await c.createEvent(e.id, e.faceValue, e.supply, e.maxResaleBps, e.organizerShareBps, e.maxPerIdentity)).wait();
  }

  const out = { network: network.name, chainId: Number((await ethers.provider.getNetwork()).chainId), address,
    deployer: deployer.address, operator, gate, deployedAt: new Date().toISOString() };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log("TiketAman deployed:", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
