// scripts/release-stuck-deposit.js
// Diagnostica y libera el depósito atascado de un usuario específico en PengPoolV2.
//
// Casos que maneja:
//   1. Depósito en cola (no emparejado)  → withdrawDeposit() sólo puede llamarlo el
//      propio usuario. El script lo reporta pero NO puede ejecutarlo con la owner key.
//   2. Usuario en match ACTIVO           → cancelMatch(matchId) como matchmaker ✓
//   3. Usuario ganador con premio sin reclamar (FINISHED, betAmount > 0)
//      → si han pasado ≥ 24 h: expiredClaim(matchId) como owner ✓
//      → si no han pasado 24 h: reporta el matchId para que el usuario reclame.

require("dotenv").config();
const { ethers } = require("ethers");

// ─── Config ────────────────────────────────────────────────────────────────
const CONTRACT_ADDRESS = "0x1E27Ff0Ca71e8284437d8a64705ecbd23C8e0922";
const TARGET_PLAYER    = "0x151b83185aCBEC4A41f71D9488a428832e0817c9";
const RPC_URL          = process.env.RPC_URL || "https://api.testnet.abs.xyz";
const PRIVATE_KEY      = process.env.PRIVATE_KEY;

const ABI = [
  // views
  "function getDeposit(address player) view returns (uint256 amount, uint8 betUSD, bool matched)",
  "function matchCount() view returns (uint256)",
  "function getMatch(uint256 matchId) view returns (address player1, address player2, uint256 betAmount, uint8 betUSD, uint8 status, address winner, uint256 declaredAt)",
  "function matchmaker() view returns (address)",
  "function owner() view returns (address)",
  // write – matchmaker only
  "function cancelMatch(uint256 matchId) external",
  // write – owner only
  "function expiredClaim(uint256 matchId) external",
];

const MATCH_STATUS = { 0: "ACTIVE", 1: "FINISHED" };
const CLAIM_EXPIRY_SEC = 24 * 60 * 60; // 24 horas (igual al contrato)

// ─── Helpers ───────────────────────────────────────────────────────────────
function addr(a) { return a.toLowerCase(); }

async function scanMatchesForPlayer(contract, playerAddress, total) {
  const found = [];
  const limit = Number(total);
  console.log(`\nEscaneando ${limit} match(es) buscando a ${playerAddress}...`);
  for (let i = 0; i < limit; i++) {
    const m = await contract.getMatch(i);
    if (
      addr(m.player1) === addr(playerAddress) ||
      addr(m.player2) === addr(playerAddress)
    ) {
      found.push({ id: i, ...m });
      const statusStr = MATCH_STATUS[Number(m.status)] ?? m.status.toString();
      console.log(`  match #${i}: status=${statusStr} betAmount=${ethers.formatEther(m.betAmount)} ETH player1=${m.player1} player2=${m.player2}`);
    }
  }
  return found;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY no definida en .env");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer   = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

  const network = await provider.getNetwork();
  console.log(`Red: chainId ${network.chainId}`);
  console.log(`Signer (owner/matchmaker key): ${signer.address}`);
  console.log(`Target player:                 ${TARGET_PLAYER}`);

  // ── 1. Verificar roles ───────────────────────────────────────────────────
  const [ownerAddr, matchmakerAddr] = await Promise.all([
    contract.owner(),
    contract.matchmaker(),
  ]);
  const isOwner      = addr(signer.address) === addr(ownerAddr);
  const isMatchmaker = addr(signer.address) === addr(matchmakerAddr);
  console.log(`\nowner:      ${ownerAddr} ${isOwner      ? "← eres tú ✓" : ""}`);
  console.log(`matchmaker: ${matchmakerAddr} ${isMatchmaker ? "← eres tú ✓" : ""}`);

  // ── 2. Estado del depósito del usuario ───────────────────────────────────
  console.log("\n─── Depósito del usuario ───");
  const dep = await contract.getDeposit(TARGET_PLAYER);
  console.log(`  amount:  ${dep.amount.toString()} wei (${ethers.formatEther(dep.amount)} ETH)`);
  console.log(`  betUSD:  ${dep.betUSD}`);
  console.log(`  matched: ${dep.matched}`);

  // ── 3. Escanear matches ──────────────────────────────────────────────────
  const total   = await contract.matchCount();
  console.log(`\nmatchCount: ${total}`);
  const matches = await scanMatchesForPlayer(contract, TARGET_PLAYER, total);

  // ── 4. Decidir acción ────────────────────────────────────────────────────
  console.log("\n─── Evaluando acción ───");

  // Caso A: depósito en cola (no emparejado)
  if (dep.amount > 0n && !dep.matched) {
    console.log("⚠  El usuario tiene un depósito en cola sin emparejar.");
    console.log("   withdrawDeposit() sólo puede ser llamado por el propio usuario (msg.sender).");
    console.log("   La owner key NO puede retirarlo directamente.");
    console.log("   Solución: el usuario debe llamar withdrawDeposit() con su propia wallet.");
    return;
  }

  // Caso B: match ACTIVO (podemos cancelar como matchmaker)
  const activeMatch = matches.find(m => Number(m.status) === 0);
  if (activeMatch) {
    if (!isMatchmaker) {
      console.log(`⚠  Se encontró match ACTIVO #${activeMatch.id} pero el signer NO es el matchmaker.`);
      console.log(`   Matchmaker requerido: ${matchmakerAddr}`);
      return;
    }
    console.log(`✓ Match ACTIVO encontrado: #${activeMatch.id}`);
    console.log("  Llamando cancelMatch() → ambos jugadores recibirán su depósito de vuelta...");
    const tx = await contract.cancelMatch(activeMatch.id);
    console.log(`  tx enviada: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  Confirmado en bloque ${receipt.blockNumber} ✓`);
    return;
  }

  // Caso C: match FINISHED con betAmount > 0 (premio no reclamado)
  const now = Math.floor(Date.now() / 1000);
  const finishedUnclaimed = matches.find(
    m => Number(m.status) === 1 && m.betAmount > 0n
  );
  if (finishedUnclaimed) {
    const declaredAt = Number(finishedUnclaimed.declaredAt);
    const elapsed    = now - declaredAt;
    const remaining  = CLAIM_EXPIRY_SEC - elapsed;
    console.log(`  Match FINISHED #${finishedUnclaimed.id}: ganador=${finishedUnclaimed.winner}`);
    console.log(`  declaredAt: ${new Date(declaredAt * 1000).toISOString()}`);
    console.log(`  Tiempo transcurrido desde declaración: ${Math.round(elapsed / 60)} min`);

    if (addr(finishedUnclaimed.winner) === addr(TARGET_PLAYER)) {
      console.log(`⚠  El usuario es el GANADOR del match #${finishedUnclaimed.id}.`);
      console.log("   claimWinnings() sólo puede ser llamado por el ganador (msg.sender).");
      if (elapsed >= CLAIM_EXPIRY_SEC && isOwner) {
        console.log(`   Han pasado ≥ 24 h → el owner puede llamar expiredClaim(${finishedUnclaimed.id}).`);
        console.log(`   Esto envía el pot a commissionWallet, NO al jugador.`);
        // Descomenta para ejecutar:
        // const tx = await contract.expiredClaim(finishedUnclaimed.id);
        // await tx.wait();
        // console.log("  expiredClaim ejecutado ✓");
      } else {
        console.log(`   Quedan ~${Math.round(remaining / 60)} min para que expire el plazo de 24 h.`);
        console.log(`   El usuario debe llamar claimWinnings(${finishedUnclaimed.id}) con su wallet.`);
      }
    } else {
      console.log(`   El usuario era jugador pero el ganador fue ${finishedUnclaimed.winner}.`);
      console.log(`   Los fondos del perdedor forman parte del pot que el ganador debe reclamar.`);
    }
    return;
  }

  // Sin casos pendientes
  if (dep.amount === 0n && matches.length === 0) {
    console.log("ℹ  No hay depósito ni matches pendientes para este usuario.");
  } else {
    console.log("ℹ  No se encontró ninguna acción ejecutable con la clave actual.");
    console.log("   Revisá los datos arriba para más contexto.");
  }
}

main().catch(err => {
  console.error("Error:", err.message ?? err);
  process.exit(1);
});
