require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Mode offline: gunakan solc-js dari npm bila binaries.soliditylang.org tidak dapat diakses.
if (process.env.SOLC_OFFLINE === "true") {
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
    if (args.solcVersion === "0.8.24") {
      return {
        compilerPath: require.resolve("solc/soljson.js"),
        isSolcJs: true,
        version: args.solcVersion,
        longVersion: "0.8.24+commit.e11b9ed9",
      };
    }
    return runSuper();
  });
}

// Kunci dan URL RPC dibaca dari environment variable, tidak pernah ditulis di kode.
const { SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, REPORT_GAS } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545" },
    ...(SEPOLIA_RPC_URL && DEPLOYER_PRIVATE_KEY
      ? { sepolia: { url: SEPOLIA_RPC_URL, accounts: [DEPLOYER_PRIVATE_KEY], chainId: 11155111 } }
      : {}),
  },
  gasReporter: {
    enabled: REPORT_GAS === "true",
    currency: "USD",
    noColors: true,
    outputFile: process.env.GAS_REPORT_FILE || undefined,
  },
};
