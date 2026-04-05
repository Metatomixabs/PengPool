// scripts/clear-deposits.js
const hre = require("hardhat");

async function main() {
  const PENGPOOL_V2 = "0x1E27Ff0Ca71e8284437d8a64705ecbd23C8e0922";
  const ABI = [
    "function getDeposit(address) view returns (tuple(uint256 amount, uint8 betUSD, bool matched))",
    "function withdrawDeposit() external",
  ];
  const [signer] = await hre.ethers.getSigners();
  const contract = new hre.ethers.Contract(PENGPOOL_V2, ABI, signer);

  const dep = await contract.getDeposit(signer.address);
  console.log("Deposit for", signer.address, ":", dep);
  if (dep.amount > 0n && !dep.matched) {
    console.log("Withdrawing deposit...");
    const tx = await contract.withdrawDeposit();
    await tx.wait();
    console.log("Withdrawn ✓");
  } else {
    console.log("No withdrawable deposit found");
  }
}
main().catch(console.error);
