const { ethers } = require("hardhat");

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const PENGPOOL_ADDRESS = "0xEeA18855Ffd6824dB84e17e27E616771dFAbfC1F";

const FEED_DECIMALS  = 8;
const ETH_PRICE_USD  = 2000;
const FEED_PRICE     = ETH_PRICE_USD * 10 ** FEED_DECIMALS; // 200_000_000_000

// ---------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();

  console.log("Network  :", network.name, `(chainId ${network.chainId})`);
  console.log("Deployer :", deployer.address);
  console.log("Balance  :", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("---");

  // 1. Deploy MockV3Aggregator
  console.log(`Deploying MockV3Aggregator ($${ETH_PRICE_USD}/ETH, ${FEED_DECIMALS} decimals)...`);
  const MockAggregator = await ethers.getContractFactory("MockV3Aggregator");
  const mockFeed = await MockAggregator.deploy(FEED_DECIMALS, FEED_PRICE);
  await mockFeed.waitForDeployment();

  const mockAddress = await mockFeed.getAddress();
  console.log("MockV3Aggregator deployed to:", mockAddress);

  // 2. Call setPriceFeed() on the existing PengPool
  console.log("---");
  console.log("Calling setPriceFeed() on PengPool at", PENGPOOL_ADDRESS, "...");

  const PengPool = await ethers.getContractFactory("PengPool");
  const pengPool = PengPool.attach(PENGPOOL_ADDRESS);

  const tx = await pengPool.setPriceFeed(mockAddress);
  console.log("Transaction sent:", tx.hash);
  await tx.wait();
  console.log("setPriceFeed() confirmed.");

  // 3. Verify
  const activeFeed = await pengPool.priceFeed();
  console.log("PengPool.priceFeed() now:", activeFeed);
  console.log(activeFeed.toLowerCase() === mockAddress.toLowerCase() ? "✓ Feed updated correctly." : "✗ Mismatch — check manually.");

  console.log("---");
  console.log("MockV3Aggregator :", mockAddress);
  console.log(`Explorer: https://explorer.testnet.abs.xyz/address/${mockAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
