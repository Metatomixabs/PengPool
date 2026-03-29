const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const COMMISSION_WALLET = "0x35c3F808E6500b0cA2Bb9a25640271F52a5A4284";
  const MATCHMAKER        = deployer.address; // server wallet = deployer
  const PRICE_FEED        = "0x694AA1769357215DE4FAC081bf1f309aDC325306"; // Sepolia Chainlink ETH/USD

  console.log("Deploying PengPoolV2...");
  console.log("  Deployer:          ", deployer.address);
  console.log("  Commission wallet: ", COMMISSION_WALLET);
  console.log("  Matchmaker:        ", MATCHMAKER);
  console.log("  Price feed:        ", PRICE_FEED);

  const PengPoolV2 = await hre.ethers.getContractFactory("PengPoolV2");
  const contract   = await PengPoolV2.deploy(COMMISSION_WALLET, MATCHMAKER, PRICE_FEED);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("PengPoolV2 deployed to:", address);

  // Enable skipStalenessCheck for testnet
  console.log("Setting skipStalenessCheck = true (testnet)...");
  await contract.setSkipStalenessCheck(true);
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
