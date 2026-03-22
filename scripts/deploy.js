const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// Deployment parameters
// ---------------------------------------------------------------------------

const COMMISSION_WALLET = "0x35c3F808E6500b0cA2Bb9a25640271F52a5A4284";

// Chainlink ETH/USD price feed.
// Abstract testnet does not have Chainlink yet — using the Sepolia feed address
// as a placeholder so the contract is deployed and ownable.
// *** Call setPriceFeed() with the correct address once Chainlink is live on Abstract. ***
// Sepolia  ETH/USD : 0x694AA1769357215DE4FAC081bf1f309aDC325306
// Abstract mainnet : check https://docs.chain.link/data-feeds/price-feeds/addresses
const PRICE_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";

// ---------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();

  console.log("Network  :", network.name, `(chainId ${network.chainId})`);
  console.log("Deployer :", deployer.address);
  console.log("Balance  :", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("---");
  console.log("Commission wallet :", COMMISSION_WALLET);
  console.log("Price feed        :", PRICE_FEED, "(Sepolia placeholder — update after Chainlink on Abstract)");
  console.log("---");

  const PengPool = await ethers.getContractFactory("PengPool");
  console.log("Deploying PengPool...");

  const pengPool = await PengPool.deploy(COMMISSION_WALLET, PRICE_FEED);
  await pengPool.waitForDeployment();

  const address = await pengPool.getAddress();
  console.log("PengPool deployed to:", address);
  console.log(`Explorer: https://explorer.testnet.abs.xyz/address/${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
