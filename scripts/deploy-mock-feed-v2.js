const hre = require("hardhat");

async function main() {
  const PENGPOOL_V2 = "0x1E27Ff0Ca71e8284437d8a64705ecbd23C8e0922";
  const FEED_PRICE  = 200_000_000_000n; // $2000/ETH, 8 decimals

  console.log("Deploying MockV3Aggregator...");
  const Mock = await hre.ethers.getContractFactory("MockV3Aggregator");
  const mock = await Mock.deploy(8, FEED_PRICE);
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log("MockV3Aggregator deployed to:", mockAddr);

  console.log("Setting price feed on PengPoolV2...");
  const v2Abi = ["function setPriceFeed(address) external"];
  const [signer] = await hre.ethers.getSigners();
  const v2 = new hre.ethers.Contract(PENGPOOL_V2, v2Abi, signer);
  await v2.setPriceFeed(mockAddr);
  console.log("Price feed updated on PengPoolV2 ✓");
  console.log("Mock feed address:", mockAddr);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
