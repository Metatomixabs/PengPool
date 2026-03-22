require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-gas-reporter");
require("solidity-coverage");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL     = process.env.RPC_URL || "https://api.testnet.abs.xyz";

// Only include the account when PRIVATE_KEY is a valid 32-byte hex string.
// This allows running tests and local tasks without a real key in .env.
const isValidKey = typeof PRIVATE_KEY === "string" && /^(0x)?[0-9a-fA-F]{64}$/.test(PRIVATE_KEY);

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.28",

  networks: {
    hardhat: {},

    // Abstract testnet
    // Chainlink price feed not yet available on Abstract testnet.
    // Deploy using the Sepolia ETH/USD feed (0x694AA1769357215DE4FAC081bf1f309aDC325306)
    // and call setPriceFeed() once Chainlink is live on Abstract.
    abstractTestnet: {
      url:      RPC_URL,
      chainId:  11124,
      accounts: isValidKey ? [PRIVATE_KEY] : [],
    },
  },

  gasReporter: {
    enabled:  process.env.REPORT_GAS !== undefined,
    currency: "USD",
  },
};
