"use strict";

const { ethers } = require("ethers");
const cron        = require("node-cron");

// ─────────────────────────────────────────────────────────────────────────────
// Contract
// ─────────────────────────────────────────────────────────────────────────────

const TOURNAMENT_ADDRESS = "0x03F938697Ec69232426a5B82187Ef2c7BF561dEF";

const TOURNAMENT_ABI = [
  "function createTournament(string name, uint256 buyInUSD, uint256 startTime, bool isCustom, address creator) external returns (uint256)",
  "function startTournament(uint256 tournamentId) external",
  "function declareMatchWinner(uint256 tournamentId, uint256 matchId, address winner) external",
  "function distributePrizes(uint256 tournamentId, address[] winners, uint256[] percentages) external",
  "function expiredPrizeClaim(uint256 tournamentId, address player) external",
  "function getTournamentInfo(uint256 tournamentId) external view returns (string name, uint256 buyInUSD, uint256 startTime, uint8 status, uint256 participantCount, uint256 prizePool, bool isCustom, address creator)",
  "function getPendingPrize(uint256 tournamentId, address player) external view returns (uint256)",
  "event TournamentCreated(uint256 indexed tournamentId, string name, uint256 buyInUSD, uint256 startTime, bool isCustom, address creator)",
];

// ─────────────────────────────────────────────────────────────────────────────
// Prize distribution scale
// percentages sum to 100, represent each winner's share of the 90% prize pool
// ─────────────────────────────────────────────────────────────────────────────

const PRIZE_SCALES = [
  { maxParticipants: 9,   positions: 1,  percentages: [100] },
  { maxParticipants: 30,  positions: 3,  percentages: [65, 25, 10] },
  { maxParticipants: 50,  positions: 5,  percentages: [50, 25, 12, 8, 5] },
  { maxParticipants: 100, positions: 10, percentages: [35, 20, 13, 9, 6, 5, 4, 3, 3, 2] },
];

function _getPrizeScale(participantCount) {
  for (const scale of PRIZE_SCALES) {
    if (participantCount <= scale.maxParticipants) return scale;
  }
  return PRIZE_SCALES[PRIZE_SCALES.length - 1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Level helper (mirrors db.js formula)
// ─────────────────────────────────────────────────────────────────────────────

function _levelForPoints(pts) {
  let level = 0;
  for (let n = 1; n <= 50; n++) {
    if (pts >= Math.floor(50 * Math.pow(n, 1.8))) level = n;
    else break;
  }
  return level;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state — populated by initTournament()
// ─────────────────────────────────────────────────────────────────────────────

let _wss      = null;
let _pool     = null;
let _wallet   = null;
let _provider = null;
let _rooms    = null;   // the same Map used by server.js
let _contract = null;

const CORS = { "Access-Control-Allow-Origin": "*" };

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function _getContract() {
  if (!_contract) _contract = new ethers.Contract(TOURNAMENT_ADDRESS, TOURNAMENT_ABI, _wallet);
  return _contract;
}

/** Send a WS message to a specific wallet address (finds their open socket). */
function _sendToAddr(addr, obj) {
  const target = addr.toLowerCase();
  for (const ws of _wss.clients) {
    if (ws._addr && ws._addr.toLowerCase() === target && ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(obj));
      return true;
    }
  }
  return false;
}

/** Broadcast a WS message to all connected clients. */
function _broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const ws of _wss.clients) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

/** Read the full body of an HTTP request. */
function _readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/** Send JSON HTTP response. */
function _json(res, status, data) {
  try {
    if (!res.headersSent) {
      res.writeHead(status, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(data));
    }
  } catch (_) {}
}

const _startingTournaments = new Set();

/**
 * Compute the next UTC occurrence of a given weekday + hour.
 * @param {number} dayOfWeek  0 = Sunday … 6 = Saturday
 * @param {number} hour       0–23 UTC
 */
function _nextOccurrence(dayOfWeek, hour) {
  const now        = new Date();
  const currentDay = now.getUTCDay();
  let   daysUntil  = (dayOfWeek - currentDay + 7) % 7;
  const target     = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil,
    hour, 0, 0, 0
  ));
  // Same day but time already passed → push one week forward
  if (daysUntil === 0 && now >= target) target.setUTCDate(target.getUTCDate() + 7);
  return target;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bracket generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build round-1 match records for a tournament.
 * @param {{ addr: string, level: number }[]} players
 * @returns match objects ready for DB insertion (no tournament_id yet)
 */
function generateBracket(players) {
  // Seed: highest level first
  const sorted = [...players].sort((a, b) => b.level - a.level);
  const n      = players.length;

  // Next power of 2
  let size = 1;
  while (size < n) size *= 2;

  const byeCount   = size - n;
  const byePlayers = sorted.slice(0, byeCount);      // top seeds get byes
  const real       = sorted.slice(byeCount);

  const matches    = [];
  let chainMatchId = 1;
  let matchNumber  = 1;

  // Bye matches — already finished, winner set immediately
  for (const p of byePlayers) {
    matches.push({
      chain_match_id: chainMatchId++,
      round:          1,
      match_number:   matchNumber++,
      player1_addr:   p.addr,
      player2_addr:   null,
      winner_addr:    p.addr,
      is_bye:         true,
      status:         "finished",
    });
  }

  // Real round-1 matches
  for (let i = 0; i < real.length; i += 2) {
    const p1 = real[i];
    const p2 = real[i + 1] || null;
    if (!p2) {
      // Odd real player — give another bye
      matches.push({
        chain_match_id: chainMatchId++,
        round:          1,
        match_number:   matchNumber++,
        player1_addr:   p1.addr,
        player2_addr:   null,
        winner_addr:    p1.addr,
        is_bye:         true,
        status:         "finished",
      });
    } else {
      matches.push({
        chain_match_id: chainMatchId++,
        round:          1,
        match_number:   matchNumber++,
        player1_addr:   p1.addr,
        player2_addr:   p2.addr,
        winner_addr:    null,
        is_bye:         false,
        status:         "pending",
      });
    }
  }

  return matches;
}

// ─────────────────────────────────────────────────────────────────────────────
// Init — called once from server.js
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {import('pg').Pool}            pool
 * @param {import('ethers').Wallet}      wallet
 * @param {import('ethers').Provider}    provider
 * @param {Map}                          rooms   — same Map used by server.js
 */
function initTournament(wss, pool, wallet, provider, rooms) {
  _wss      = wss;
  _pool     = pool;
  _wallet   = wallet;
  _provider = provider;
  _rooms    = rooms;

  // Every minute — auto-start, expire abandoned, and finalize stuck tournaments.
  cron.schedule("* * * * *", async () => {
    // 1. Auto-start tournaments whose start_time has arrived.
    try {
      const { rows } = await _pool.query(
        `SELECT id FROM tournaments
         WHERE status = 'registration' AND start_time <= NOW() AND participant_count >= 2`
      );
      for (const { id } of rows) {
        console.log(`[tournament cron] auto-starting tournament ${id}`);
        await startTournamentById(id).catch(e =>
          console.error(`[tournament cron] startTournamentById(${id}) failed:`, e.message)
        );
      }
    } catch (e) {
      console.error("[tournament cron] auto-start check failed:", e);
    }

    // 2. Cancel abandoned registration tournaments: start_time passed >30 min ago, <2 participants.
    try {
      const { rows: abandoned } = await _pool.query(
        `SELECT id FROM tournaments
         WHERE status = 'registration'
           AND start_time <= NOW() - INTERVAL '30 minutes'
           AND participant_count < 2`
      );
      for (const { id } of abandoned) {
        console.log(`[tournament cron] cancelling abandoned tournament ${id}`);
        await _pool.query(`UPDATE tournaments SET status = 'cancelled' WHERE id = $1`, [id]);
      }
    } catch (e) {
      console.error("[tournament cron] abandon-cancel check failed:", e.message);
    }

    // 3. Safety-net: finalize active tournaments where all matches are already finished.
    try {
      const { rows: stuck } = await _pool.query(
        `SELECT t.id FROM tournaments t
         WHERE t.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM tournament_matches m
             WHERE m.tournament_id = t.id AND m.status != 'finished'
           )`
      );
      for (const { id } of stuck) {
        console.log(`[tournament cron] safety-net finalizing stuck tournament ${id}`);
        await finalizeTournament(id).catch(e =>
          console.error(`[tournament cron] finalizeTournament(${id}) failed:`, e.message)
        );
      }
    } catch (e) {
      console.error("[tournament cron] safety-net check failed:", e.message);
    }
  });

  console.log("[tournament] module initialised");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tournament creation
// ─────────────────────────────────────────────────────────────────────────────

async function createCustomTournament(creatorAddr, name, buyInUSD, startTimeUnix) {
  if (!name || !name.trim())           throw new Error("Name cannot be empty");
  if (name.trim().length > 50)         throw new Error("Name cannot exceed 50 characters");
  if (![1, 2, 5].includes(Number(buyInUSD))) throw new Error("Buy-in must be 1, 2, or 5 USD");
  if (startTimeUnix <= Math.floor(Date.now() / 1000)) throw new Error("Start time must be in the future");

  const startTime = new Date(startTimeUnix * 1000);
  return _createTournamentRecord(name.trim(), Number(buyInUSD), startTime, true, creatorAddr);
}

/** Shared logic: call contract, then insert DB record. */
async function _createTournamentRecord(name, buyInUSD, startTimeDate, isCustom, creatorAddr) {
  const startTimeUnix = Math.floor(startTimeDate.getTime() / 1000);

  // On-chain
  let chainId = null;
  try {
    const tx      = await _getContract().createTournament(
      name, BigInt(buyInUSD), BigInt(startTimeUnix), isCustom, creatorAddr
    );
    const receipt = await tx.wait();
    const iface   = new ethers.Interface(TOURNAMENT_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "TournamentCreated") {
          chainId = Number(parsed.args.tournamentId);
          break;
        }
      } catch (_) {}
    }
    console.log(`[tournament] created on-chain: chainId=${chainId} name="${name}"`);
  } catch (e) {
    console.error("[tournament] createTournament contract call failed:", e.message);
    throw e;
  }

  if (chainId === null) throw new Error("Could not parse TournamentCreated event");

  // DB
  const { rows: [record] } = await _pool.query(
    `INSERT INTO tournaments (chain_id, name, type, creator_addr, buy_in_usd, start_time)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [chainId, name, isCustom ? "custom" : "regular", creatorAddr.toLowerCase(),
     buyInUSD, startTimeDate.toISOString()]
  );

  console.log(`[tournament] DB record inserted: id=${record.id} chain_id=${chainId}`);

  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start tournament
// ─────────────────────────────────────────────────────────────────────────────

async function startTournamentById(dbId) {
  if (_startingTournaments.has(dbId)) {
    console.log(`[tournament] startTournamentById(${dbId}) already in progress, skipping`);
    return;
  }
  _startingTournaments.add(dbId);
  try {
  const { rows: [t] } = await _pool.query(
    "SELECT * FROM tournaments WHERE id = $1", [dbId]
  );
  if (!t) throw new Error(`Tournament ${dbId} not found`);
  if (t.status !== "registration") throw new Error(`Tournament ${dbId} is not in registration status`);

  // Fetch participants with their level
  const { rows: participants } = await _pool.query(
    `SELECT tp.player_addr, COALESCE(p.points, 0) AS points
     FROM tournament_participants tp
     LEFT JOIN players p ON LOWER(p.wallet) = LOWER(tp.player_addr)
     WHERE tp.tournament_id = $1`,
    [dbId]
  );

  if (participants.length < 2) throw new Error("Need at least 2 participants");

  const players = participants.map(p => ({
    addr:  p.player_addr,
    level: _levelForPoints(parseInt(p.points, 10)),
  }));

  // On-chain — non-fatal: bracket generation and DB updates proceed even if this fails
  try {
    const tx = await _getContract().startTournament(BigInt(t.chain_id));
    await tx.wait();
    console.log(`[tournament] startTournament confirmed: chainId=${t.chain_id}`);
  } catch (e) {
    console.error("[tournament] startTournament contract call failed (non-fatal):", e.message);
    // Continue — match results are settled via declareMatchWinner() individually
  }

  // Generate round-1 bracket
  const matchRecords = generateBracket(players);

  // Insert matches
  for (const m of matchRecords) {
    await _pool.query(
      `INSERT INTO tournament_matches
         (tournament_id, chain_match_id, round, match_number,
          player1_addr, player2_addr, winner_addr, is_bye, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [dbId, m.chain_match_id, m.round, m.match_number,
       m.player1_addr, m.player2_addr, m.winner_addr, m.is_bye, m.status]
    );
  }

  // Update tournament status
  await _pool.query(
    "UPDATE tournaments SET status = 'active' WHERE id = $1", [dbId]
  );

  // Open real (non-bye) first-round matches
  await openNextMatches(dbId);

  // Broadcast
  const bracket = await _getBracket(dbId);
  _broadcast({
    type:             "tournament_started",
    tournamentId:     dbId,
    participantCount: participants.length,
    bracket,
  });

  console.log(`[tournament] started: id=${dbId} participants=${participants.length}`);
  } finally {
    _startingTournaments.delete(dbId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Open next pending matches (creates rooms + starts join timers)
// ─────────────────────────────────────────────────────────────────────────────

async function openNextMatches(tournamentDbId) {
  const { rows: [t] } = await _pool.query(
    "SELECT * FROM tournaments WHERE id = $1", [tournamentDbId]
  );

  // Current round = highest round number with any matches
  const { rows: [{ max_round }] } = await _pool.query(
    "SELECT MAX(round) AS max_round FROM tournament_matches WHERE tournament_id = $1",
    [tournamentDbId]
  );
  if (!max_round) return;

  const { rows: pendingMatches } = await _pool.query(
    `SELECT * FROM tournament_matches
     WHERE tournament_id = $1 AND round = $2 AND status = 'pending'
       AND player1_addr IS NOT NULL AND player2_addr IS NOT NULL`,
    [tournamentDbId, max_round]
  );

  for (const match of pendingMatches) {
    const roomId = `t_${tournamentDbId}_${match.id}`;

    _rooms.set(roomId, {
      p1:                 null,
      p2:                 null,
      p1addr:             match.player1_addr,
      p2addr:             match.player2_addr,
      p1alias:            null,
      p2alias:            null,
      betUSD:             String(t.buy_in_usd),
      matchId:            roomId,
      isTournament:       true,
      tournamentId:       tournamentDbId,
      tournamentMatchId:  match.id,
      tournamentRound:    match.round,
      timeoutFired:       false,
    });

    // Mark match active and store roomId
    await _pool.query(
      "UPDATE tournament_matches SET status = 'active', room_id = $1 WHERE id = $2",
      [roomId, match.id]
    );

    // Resolve aliases from players table (fallback to shortened address)
    const { rows: aliasRows } = await _pool.query(
      `SELECT LOWER(wallet) AS addr, username FROM players
       WHERE LOWER(wallet) = ANY($1)`,
      [[match.player1_addr.toLowerCase(), match.player2_addr.toLowerCase()]]
    );
    const aliasMap = {};
    for (const r of aliasRows) aliasMap[r.addr] = r.username || null;
    const p1alias = aliasMap[match.player1_addr.toLowerCase()] || match.player1_addr.slice(0, 8) + '…';
    const p2alias = aliasMap[match.player2_addr.toLowerCase()] || match.player2_addr.slice(0, 8) + '…';

    // Notify both players
    const basePayload = {
      type:           "tournament_match_ready",
      tournamentId:   tournamentDbId,
      matchId:        match.id,
      roomId,
      round:          match.round,
      buyInUSD:       t.buy_in_usd,
      timeoutSeconds: 180,
    };
    _sendToAddr(match.player1_addr, { ...basePayload, opponentAddr: match.player2_addr, opponentAlias: p2alias });
    _sendToAddr(match.player2_addr, { ...basePayload, opponentAddr: match.player1_addr, opponentAlias: p1alias });

    // 3-minute join timers — each fires only if the respective player hasn't joined
    const room = _rooms.get(roomId);

    room.p1JoinTimer = setTimeout(async () => {
      const r = _rooms.get(roomId);
      if (!r || r.timeoutFired || r.p1) return;
      r.timeoutFired = true;
      await handlePlayerTimeout(tournamentDbId, match.id,
        match.player1_addr, match.player2_addr)
        .catch(e => console.error("[tournament] p1 join timeout handler failed:", e.message));
    }, 180_000);

    room.p2JoinTimer = setTimeout(async () => {
      const r = _rooms.get(roomId);
      if (!r || r.timeoutFired || r.p2) return;
      r.timeoutFired = true;
      await handlePlayerTimeout(tournamentDbId, match.id,
        match.player2_addr, match.player1_addr)
        .catch(e => console.error("[tournament] p2 join timeout handler failed:", e.message));
    }, 180_000);

    console.log(`[tournament] room opened: ${roomId} (${match.player1_addr.slice(0,8)}… vs ${match.player2_addr.slice(0,8)}…)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Match result — called by server.js when a tournament room game ends
// ─────────────────────────────────────────────────────────────────────────────

async function handleMatchResult(gameId, winnerAddr, loserAddr) {
  const room = _rooms.get(String(gameId));
  if (!room || !room.isTournament) return;

  const { tournamentId, tournamentMatchId, tournamentRound } = room;

  // Update DB
  await _pool.query(
    "UPDATE tournament_matches SET winner_addr = $1, status = 'finished' WHERE id = $2",
    [winnerAddr, tournamentMatchId]
  );

  // On-chain
  const { rows: [match] } = await _pool.query(
    "SELECT chain_match_id FROM tournament_matches WHERE id = $1", [tournamentMatchId]
  );
  const { rows: [t] }     = await _pool.query(
    "SELECT chain_id FROM tournaments WHERE id = $1", [tournamentId]
  );

  try {
    const tx = await _getContract().declareMatchWinner(
      BigInt(t.chain_id), BigInt(match.chain_match_id), winnerAddr
    );
    await tx.wait();
    console.log(`[tournament] declareMatchWinner: match=${tournamentMatchId} winner=${winnerAddr.slice(0,8)}…`);
  } catch (e) {
    console.error("[tournament] declareMatchWinner failed:", e.message);
  }

  // Broadcast bracket update
  _broadcast({
    type:         "tournament_bracket_update",
    tournamentId,
    matchId:      tournamentMatchId,
    winnerAddr,
    round:        tournamentRound,
  });

  await checkRoundComplete(tournamentId, tournamentRound);
}

// ─────────────────────────────────────────────────────────────────────────────
// Round completion check
// ─────────────────────────────────────────────────────────────────────────────

async function checkRoundComplete(tournamentDbId, round) {
  const { rows: [{ unfinished }] } = await _pool.query(
    `SELECT COUNT(*) AS unfinished FROM tournament_matches
     WHERE tournament_id = $1 AND round = $2 AND status != 'finished'`,
    [tournamentDbId, round]
  );
  if (parseInt(unfinished, 10) > 0) return; // round not yet complete

  const { rows: winners } = await _pool.query(
    `SELECT winner_addr FROM tournament_matches
     WHERE tournament_id = $1 AND round = $2`,
    [tournamentDbId, round]
  );
  const uniqueWinners = new Set(winners.map(w => w.winner_addr).filter(Boolean));

  _broadcast({
    type:         "tournament_round_complete",
    tournamentId: tournamentDbId,
    round,
    nextRound:    round + 1,
  });

  if (uniqueWinners.size === 1) {
    // Exactly one player left standing — this was the final round
    await finalizeTournament(tournamentDbId);
  } else {
    await _generateNextRoundMatches(tournamentDbId, round);
    await openNextMatches(tournamentDbId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate next round matches from previous round winners
// ─────────────────────────────────────────────────────────────────────────────

async function _generateNextRoundMatches(tournamentDbId, completedRound) {
  const { rows: winners } = await _pool.query(
    `SELECT winner_addr FROM tournament_matches
     WHERE tournament_id = $1 AND round = $2 ORDER BY match_number ASC`,
    [tournamentDbId, completedRound]
  );

  const winnerAddrs = winners.map(w => w.winner_addr);

  if (winnerAddrs.length === 1) {
    console.log(`[tournament] only 1 winner in round ${completedRound}, finalizing directly`);
    await finalizeTournament(tournamentDbId);
    return;
  }

  const nextRound = completedRound + 1;

  const { rows: [{ max_id }] } = await _pool.query(
    `SELECT COALESCE(MAX(chain_match_id), 0) AS max_id
     FROM tournament_matches WHERE tournament_id = $1`,
    [tournamentDbId]
  );

  let chainMatchId = parseInt(max_id, 10) + 1;

  for (let i = 0; i < winnerAddrs.length; i += 2) {
    const p1    = winnerAddrs[i];
    const p2    = winnerAddrs[i + 1] || null;
    const isBye = !p2;

    await _pool.query(
      `INSERT INTO tournament_matches
         (tournament_id, chain_match_id, round, match_number,
          player1_addr, player2_addr, winner_addr, is_bye, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tournamentDbId, chainMatchId++, nextRound, Math.floor(i / 2) + 1,
       p1, p2, isBye ? p1 : null, isBye, isBye ? "finished" : "pending"]
    );
  }

  console.log(`[tournament] generated round ${nextRound} matches for tournament ${tournamentDbId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize tournament — distribute prizes
// ─────────────────────────────────────────────────────────────────────────────

async function finalizeTournament(tournamentDbId) {
  const { rows: [t] } = await _pool.query(
    "SELECT * FROM tournaments WHERE id = $1", [tournamentDbId]
  );

  const scale = _getPrizeScale(t.participant_count);

  // Pull all non-bye matches from the final round backwards to build standings
  const { rows: allMatches } = await _pool.query(
    `SELECT * FROM tournament_matches
     WHERE tournament_id = $1 AND winner_addr IS NOT NULL
     ORDER BY round DESC, match_number ASC`,
    [tournamentDbId]
  );

  const maxRound = allMatches[0]?.round ?? 1;
  const standings = [];

  for (let r = maxRound; r >= 1 && standings.length < scale.positions; r--) {
    const roundMatches = allMatches.filter(m => m.round === r && !m.is_bye);
    for (const match of roundMatches) {
      if (!match.player1_addr || !match.player2_addr) continue;

      const loser = match.player1_addr.toLowerCase() === match.winner_addr.toLowerCase()
        ? match.player2_addr : match.player1_addr;

      if (r === maxRound && standings.length === 0) {
        standings.push({ position: 1, addr: match.winner_addr });
        if (standings.length < scale.positions) {
          standings.push({ position: 2, addr: loser });
        }
      } else {
        standings.push({ position: standings.length + 1, addr: loser });
      }

      if (standings.length >= scale.positions) break;
    }
  }

  if (!standings.length) {
    console.error("[tournament] finalize: could not determine standings for", tournamentDbId);
    return;
  }

  // Build percentages array; normalize if fewer winners than scale
  const count          = standings.length;
  const rawPct         = scale.percentages.slice(0, count);
  const rawSum         = rawPct.reduce((a, b) => a + b, 0);
  let   percentages;
  if (rawSum === 100) {
    percentages = rawPct;
  } else {
    const norm = rawPct.map(p => Math.round(p * 100 / rawSum));
    const diff = 100 - norm.reduce((a, b) => a + b, 0);
    norm[norm.length - 1] += diff; // absorb rounding dust in last slot
    percentages = norm;
  }

  const winnerAddrs = standings.map(s => s.addr);

  console.log(`[tournament] distributePrizes: id=${tournamentDbId} winners=`, winnerAddrs);

  try {
    const tx = await _getContract().distributePrizes(
      BigInt(t.chain_id),
      winnerAddrs,
      percentages.map(p => BigInt(p))
    );
    await tx.wait();
    console.log(`[tournament] distributePrizes confirmed: ${tx.hash}`);
  } catch (e) {
    console.error("[tournament] distributePrizes failed:", e.message);
    // Continue — still update DB so the tournament doesn't stay 'active' forever
  }

  // Update DB
  await _pool.query("UPDATE tournaments SET status = 'finished' WHERE id = $1", [tournamentDbId]);

  for (const s of standings) {
    await _pool.query(
      `UPDATE tournament_participants SET final_position = $1
       WHERE tournament_id = $2 AND LOWER(player_addr) = LOWER($3)`,
      [s.position, tournamentDbId, s.addr]
    );
  }

  // Compute estimated prize amounts for notifications
  const prizePoolFloat = parseFloat(t.prize_pool_eth);
  const standingsOut   = standings.map((s, i) => ({
    position:  s.position,
    addr:      s.addr,
    prizeETH:  (prizePoolFloat * 0.9 * percentages[i] / 100).toFixed(8),
  }));

  _broadcast({ type: "tournament_finished", tournamentId: tournamentDbId, standings: standingsOut });

  for (const entry of standingsOut) {
    _sendToAddr(entry.addr, {
      type:              "tournament_prize_available",
      tournamentId:      tournamentDbId,
      position:          entry.position,
      estimatedPrizeETH: entry.prizeETH,
    });
  }

  console.log(`[tournament] finalized: id=${tournamentDbId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Player join timeout
// ─────────────────────────────────────────────────────────────────────────────

async function handlePlayerTimeout(tournamentDbId, matchDbId, missingAddr, presentAddr) {
  console.log(`[tournament] join timeout: match=${matchDbId} missing=${missingAddr.slice(0,8)}…`);

  await _pool.query(
    `UPDATE tournament_matches
     SET winner_addr = $1, status = 'finished', is_bye = true
     WHERE id = $2`,
    [presentAddr, matchDbId]
  );

  const { rows: [match] } = await _pool.query(
    "SELECT chain_match_id, round FROM tournament_matches WHERE id = $1", [matchDbId]
  );
  const { rows: [t] }     = await _pool.query(
    "SELECT chain_id FROM tournaments WHERE id = $1", [tournamentDbId]
  );

  try {
    const tx = await _getContract().declareMatchWinner(
      BigInt(t.chain_id), BigInt(match.chain_match_id), presentAddr
    );
    await tx.wait();
  } catch (e) {
    console.error("[tournament] declareMatchWinner (timeout) failed:", e.message);
  }

  _broadcast({
    type:             "tournament_player_timeout",
    tournamentId:     tournamentDbId,
    matchId:          matchDbId,
    disqualifiedAddr: missingAddr,
    advancedAddr:     presentAddr,
  });

  // Clean up room
  const roomId = `t_${tournamentDbId}_${matchDbId}`;
  const room   = _rooms.get(roomId);
  if (room) {
    if (room.p1JoinTimer) clearTimeout(room.p1JoinTimer);
    if (room.p2JoinTimer) clearTimeout(room.p2JoinTimer);
    _rooms.delete(roomId);
  }

  await checkRoundComplete(tournamentDbId, match.round);
}

// ─────────────────────────────────────────────────────────────────────────────
// View helper — full bracket for a tournament
// ─────────────────────────────────────────────────────────────────────────────

async function _getBracket(tournamentDbId) {
  const { rows } = await _pool.query(
    `SELECT round, match_number, player1_addr, player2_addr, winner_addr, is_bye, status, room_id
     FROM tournament_matches WHERE tournament_id = $1 ORDER BY round, match_number`,
    [tournamentDbId]
  );

  const rounds = {};
  for (const m of rows) {
    if (!rounds[m.round]) rounds[m.round] = [];
    rounds[m.round].push(m);
  }

  return Object.entries(rounds)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([round, matches]) => ({ round: Number(round), matches }));
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP routes
// Exported as an array of { match(method, url), handler(req, res) }
// server.js iterates these before its own fallback.
// ─────────────────────────────────────────────────────────────────────────────

const httpRoutes = [

  // GET /api/tournaments — active + registration tournaments
  {
    match: (method, url) => method === "GET" && url === "/api/tournaments",
    handler: async (req, res) => {
      const { rows } = await _pool.query(
        `SELECT id, chain_id, name, type, buy_in_usd, start_time, status,
                participant_count, prize_pool_eth, creator_addr
         FROM tournaments
         WHERE status IN ('registration', 'active')
         ORDER BY start_time ASC`
      );
      _json(res, 200, rows);
    },
  },

  // GET /api/tournaments/finished — finished tournaments for recovery panel
  {
    match: (method, url) => method === 'GET' && url === '/api/tournaments/finished',
    handler: async (req, res) => {
      const { rows } = await _pool.query(
        `SELECT id, chain_id, name, type, buy_in_usd, start_time, status,
                participant_count, prize_pool_eth, creator_addr
         FROM tournaments
         WHERE status = 'finished'
         ORDER BY start_time DESC
         LIMIT 20`
      );
      _json(res, 200, rows);
    },
  },

  // GET /api/tournament/:id — full info + matches grouped by round
  {
    match: (method, url) => method === "GET" && /^\/api\/tournament\/\d+$/.test(url),
    handler: async (req, res) => {
      const id = parseInt(req.url.split("/").pop(), 10);
      const { rows: [t] } = await _pool.query(
        "SELECT * FROM tournaments WHERE id = $1", [id]
      );
      if (!t) return _json(res, 404, { error: "Tournament not found" });

      const bracket = await _getBracket(id);
      _json(res, 200, { ...t, bracket });
    },
  },

  // GET /api/tournament/:id/bracket — bracket only
  {
    match: (method, url) => method === "GET" && /^\/api\/tournament\/\d+\/bracket$/.test(url),
    handler: async (req, res) => {
      const id = parseInt(req.url.split("/")[3], 10);
      const { rows: [t] } = await _pool.query(
        "SELECT id FROM tournaments WHERE id = $1", [id]
      );
      if (!t) return _json(res, 404, { error: "Tournament not found" });

      const bracket = await _getBracket(id);
      _json(res, 200, { tournamentId: id, rounds: bracket });
    },
  },

  // POST /api/tournament/create-custom
  {
    match: (method, url) => method === "POST" && url === "/api/tournament/create-custom",
    handler: async (req, res) => {
      const body = JSON.parse(await _readBody(req));
      const { creatorAddr, name, buyInUSD, startTimeUnix } = body;
      if (!creatorAddr) return _json(res, 400, { error: "creatorAddr required" });
      try {
        const record = await createCustomTournament(creatorAddr, name, buyInUSD, startTimeUnix);
        _json(res, 200, record);
      } catch (e) {
        _json(res, 400, { error: e.message });
      }
    },
  },

  // GET /api/tournament/:id/prize/:addr
  {
    match: (method, url) => method === "GET" && /^\/api\/tournament\/\d+\/prize\/0x[0-9a-fA-F]{40}$/.test(url),
    handler: async (req, res) => {
      const parts  = req.url.split("/");
      const id     = parseInt(parts[3], 10);
      const addr   = parts[5];

      const { rows: [t] } = await _pool.query(
        "SELECT chain_id FROM tournaments WHERE id = $1", [id]
      );
      if (!t) return _json(res, 404, { error: "Tournament not found" });

      try {
        const raw  = await _getContract().getPendingPrize(BigInt(t.chain_id), addr);
        _json(res, 200, { pendingPrizeETH: ethers.formatEther(raw) });
      } catch (e) {
        console.error("[tournament] getPendingPrize failed:", e.message);
        _json(res, 500, { error: e.message });
      }
    },
  },

  // POST /api/tournament/:id/start — admin-only manual trigger
  {
    match: (method, url) => method === 'POST' && /^\/api\/tournament\/\d+\/start$/.test(url),
    handler: async (req, res) => {
      const adminKey = process.env.TOURNAMENT_ADMIN_KEY || 'pengpool-admin';
      if (req.headers['x-admin-key'] !== adminKey) {
        return _json(res, 403, { error: 'Forbidden' });
      }
      const id = parseInt(req.url.split('/')[3], 10);
      try {
        await startTournamentById(id);
        _json(res, 200, { ok: true });
      } catch (e) {
        _json(res, 400, { error: e.message });
      }
    },
  },

  // POST /api/tournament/register-participant
  {
    match: (method, url) => method === 'POST' && url === '/api/tournament/register-participant',
    handler: async (req, res) => {
      try {
        const body = JSON.parse(await _readBody(req));
        console.log('[tournament] register-participant:', body);
        const { tournamentId, playerAddr, ethAmount } = body;
        if (!tournamentId || !playerAddr) return _json(res, 400, { error: 'Missing fields' });

        // Find tournament by chain_id
        const { rows: [t] } = await _pool.query(
          'SELECT id FROM tournaments WHERE chain_id = $1', [tournamentId]
        );
        if (!t) return _json(res, 404, { error: 'Tournament not found' });

        // Upsert participant
        await _pool.query(
          `INSERT INTO tournament_participants (tournament_id, player_addr)
           VALUES ($1, LOWER($2))
           ON CONFLICT (tournament_id, player_addr) DO NOTHING`,
          [t.id, playerAddr]
        );

        // Update participant count and prize pool
        await _pool.query(
          `UPDATE tournaments
           SET participant_count = (
             SELECT COUNT(*) FROM tournament_participants WHERE tournament_id = $1
           ),
           prize_pool_eth = prize_pool_eth + $2
           WHERE id = $1`,
          [t.id, (Number(ethAmount) / 1e18).toFixed(18)]
        );

        _json(res, 200, { ok: true });
      } catch(e) {
        console.error('[tournament] register-participant error:', e.message);
        _json(res, 500, { error: e.message });
      }
    },
  },

];

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  initTournament,
  createCustomTournament,
  startTournamentById,
  generateBracket,
  handleMatchResult,
  httpRoutes,
};
