const hre = require("hardhat");

async function main() {
  const PENGPOOL_V2 = "0x498ECbe4dc1a7e25bb9A3A4F58FEd890f2A3E455";
  const ABI = [
    "function matchCount() view returns (uint256)",
    "function getMatch(uint256) view returns (tuple(address player1, address player2, uint256 betAmount, uint8 betUSD, uint8 status, address winner, uint256 declaredAt))",
    "function declareWinner(uint256 matchId, address winner) external",
  ];
  const [signer] = await hre.ethers.getSigners();
  const contract  = new hre.ethers.Contract(PENGPOOL_V2, ABI, signer);

  const count = await contract.matchCount();
  console.log("Total matches:", count.toString());

  for (let i = 0; i < count; i++) {
    const m = await contract.getMatch(i);
    console.log(`Match ${i}:`, {
      player1: m.player1,
      player2: m.player2,
      betAmount: m.betAmount.toString(),
      status: m.status,  // 0=ACTIVE, 1=FINISHED
      winner: m.winner,
    });
    // Declare winner for ACTIVE matches (status === 0) — refund to player1
    if (Number(m.status) === 0 && m.betAmount > 0n) {
      console.log(`Declaring winner for match ${i} → player1 (${m.player1})`);
      const tx = await contract.declareWinner(i, m.player1);
      await tx.wait();
      console.log(`Match ${i} settled ✓`);
    }
  }
}
main().catch(console.error);
