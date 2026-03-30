const hre = require("hardhat");

// Parse --matchId <n> from process.argv if present
function parseMatchId() {
  const idx = process.argv.indexOf("--matchId");
  if (idx === -1) return null;
  const val = Number(process.argv[idx + 1]);
  if (isNaN(val) || val < 0) throw new Error("--matchId must be a non-negative integer");
  return val;
}

async function settleMatch(contract, i) {
  const m = await contract.getMatch(i);
  console.log(`Match ${i}:`, {
    player1:   m.player1,
    player2:   m.player2,
    betAmount: m.betAmount.toString(),
    status:    m.status,   // 0=ACTIVE, 1=FINISHED
    winner:    m.winner,
  });
  if (Number(m.status) === 0 && m.betAmount > 0n) {
    console.log(`Declaring winner for match ${i} → player1 (${m.player1})`);
    const tx = await contract.declareWinner(i, m.player1);
    await tx.wait();
    console.log(`Match ${i} settled ✓`);
  } else if (Number(m.status) !== 0) {
    console.log(`Match ${i} already finished — skipped.`);
  } else {
    console.log(`Match ${i} is ACTIVE but betAmount is 0 — skipped.`);
  }
}

async function main() {
  const PENGPOOL_V2 = "0x498ECbe4dc1a7e25bb9A3A4F58FEd890f2A3E455";
  const ABI = [
    "function matchCount() view returns (uint256)",
    "function getMatch(uint256) view returns (tuple(address player1, address player2, uint256 betAmount, uint8 betUSD, uint8 status, address winner, uint256 declaredAt))",
    "function declareWinner(uint256 matchId, address winner) external",
  ];
  const [signer] = await hre.ethers.getSigners();
  const contract  = new hre.ethers.Contract(PENGPOOL_V2, ABI, signer);

  const matchId = parseMatchId();

  if (matchId !== null) {
    // ── Single-match mode ──────────────────────────────────────────────────
    const count = await contract.matchCount();
    if (matchId >= Number(count)) {
      throw new Error(`matchId ${matchId} does not exist (total matches: ${count})`);
    }
    await settleMatch(contract, matchId);
  } else {
    // ── Scan-all mode (original behaviour) ────────────────────────────────
    const count = await contract.matchCount();
    console.log("Total matches:", count.toString());
    for (let i = 0; i < count; i++) {
      await settleMatch(contract, i);
    }
  }
}
main().catch(console.error);
