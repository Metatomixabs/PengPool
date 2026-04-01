const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const PRICE_FEED        = "0x5df51C0ef6409fC32a88e477085Eb9F20fC1B5C9";
  const COMMISSION_WALLET = "0x35c3F808E6500b0cA2Bb9a25640271F52a5A4284";

  console.log("Deploying PengPoolTournament...");
  console.log("  Deployer:          ", deployer.address);
  console.log("  Price feed:        ", PRICE_FEED);
  console.log("  Commission wallet: ", COMMISSION_WALLET);

  const PengPoolTournament = await hre.ethers.getContractFactory("PengPoolTournament");
  const contract = await PengPoolTournament.deploy(PRICE_FEED, COMMISSION_WALLET);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("PengPoolTournament deployed to:", address);

  console.log("Setting skipStalenessCheck = true (mock price feed)...");
  const tx = await contract.setSkipStalenessCheck(true);
  await tx.wait();
  console.log("Done.");

  console.log("\n=== FINAL CONTRACT ADDRESS ===");
  console.log(address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
