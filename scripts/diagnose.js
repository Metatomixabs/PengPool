const { ethers } = require("hardhat");

const PENGPOOL_ADDRESS = "0x1E27Ff0Ca71e8284437d8a64705ecbd23C8e0922"; // PengPoolV2

const PENGPOOL_ABI = [
  "function skipStalenessCheck() view returns (bool)",
  "function priceFeed() view returns (address)",
  "function betAmountWei(uint8) view returns (uint256)",
  "function getLatestPrice() view returns (int256, uint8)",
  "function owner() view returns (address)",
  "function matchmaker() view returns (address)",
  "function getDeposit(address player) view returns (uint256 amount, uint8 betUSD, bool matched)",
  "function getMatch(uint256 matchId) view returns (address player1, address player2, uint256 betAmount, uint8 betUSD, uint8 status, address winner, uint256 declaredAt)",
];

const MOCK_ABI = [
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];

async function main() {
  const provider = ethers.provider;
  const network  = await provider.getNetwork();
  console.log("Network :", network.name, `(chainId ${network.chainId})`);
  console.log("Contract:", PENGPOOL_ADDRESS);
  console.log("---");

  const contract = new ethers.Contract(PENGPOOL_ADDRESS, PENGPOOL_ABI, provider);

  // 1. skipStalenessCheck
  const skip = await contract.skipStalenessCheck();
  console.log("skipStalenessCheck:", skip, skip ? "✓" : "✗ NOT active");

  // 2. priceFeed address
  const feedAddr = await contract.priceFeed();
  console.log("priceFeed address :", feedAddr);

  // 3. owner
  const owner = await contract.owner();
  console.log("owner             :", owner);

  // 3b. matchmaker (V2)
  const matchmaker = await contract.matchmaker();
  console.log("matchmaker        :", matchmaker);

  // 4. Check if priceFeed has code (exists on-chain)
  const code = await provider.getCode(feedAddr);
  const feedExists = code !== "0x";
  console.log("priceFeed has code:", feedExists, feedExists ? "✓" : "✗ NO CONTRACT at that address");

  if (feedExists) {
    // 5. Call latestRoundData directly on the feed
    console.log("---");
    console.log("Calling priceFeed.latestRoundData()...");
    try {
      const feed = new ethers.Contract(feedAddr, MOCK_ABI, provider);
      const [roundId, answer, startedAt, updatedAt, answeredInRound] = await feed.latestRoundData();
      const decimals = await feed.decimals();
      console.log("  roundId    :", roundId.toString());
      console.log("  answer     :", answer.toString(), `(= $${Number(answer) / 10**Number(decimals)} USD)`);
      console.log("  updatedAt  :", updatedAt.toString(), `(${new Date(Number(updatedAt) * 1000).toISOString()})`);
      console.log("  decimals   :", decimals.toString());
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
      console.log("  age        :", age, "seconds", age > 3600 ? "⚠ STALE (>1h)" : "✓ fresh");
    } catch (e) {
      console.log("  latestRoundData() FAILED:", e.message);
    }
  }

  // 6a. getDeposit for deployer (V2)
  console.log("---");
  console.log("Calling getDeposit(deployer)...");
  try {
    const [signers] = [await ethers.getSigners()];
    const dep = await contract.getDeposit(signers[0].address);
    console.log("  amount :", dep.amount.toString(), "wei");
    console.log("  betUSD :", dep.betUSD.toString());
    console.log("  matched:", dep.matched);
  } catch (e) {
    console.log("  getDeposit() FAILED:", e.message);
  }

  // 6b. getMatch(0) — check if match 0 exists (V2)
  console.log("---");
  console.log("Calling getMatch(0)...");
  try {
    const m = await contract.getMatch(0);
    console.log("  player1   :", m.player1);
    console.log("  player2   :", m.player2);
    console.log("  betAmount :", m.betAmount.toString(), "wei");
    console.log("  betUSD    :", m.betUSD.toString());
    const statuses = ["ACTIVE", "FINISHED"];
    console.log("  status    :", statuses[m.status] || m.status.toString());
    console.log("  winner    :", m.winner);
  } catch (e) {
    console.log("  getMatch(0) FAILED (no matches yet?):", e.message);
  }

  // 6. Try betAmountWei(1)
  console.log("---");
  console.log("Calling betAmountWei(1)...");
  try {
    const wei = await contract.betAmountWei(1);
    console.log("  betAmountWei(1) =", wei.toString(), "wei");
    console.log("  =", ethers.formatEther(wei), "ETH");
    console.log("  ✓ Oracle working correctly");
  } catch (e) {
    console.log("  betAmountWei(1) REVERTED:", e.message);
  }

  // 7. Try getLatestPrice()
  console.log("---");
  console.log("Calling getLatestPrice()...");
  try {
    const [price, dec] = await contract.getLatestPrice();
    console.log("  price    :", price.toString());
    console.log("  decimals :", dec.toString());
    console.log("  USD/ETH  : $" + (Number(price) / 10**Number(dec)).toFixed(2));
    console.log("  ✓ getLatestPrice working");
  } catch (e) {
    console.log("  getLatestPrice() REVERTED:", e.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
