/**
 * server.js — PengPool real-time sync server
 *
 * Relay server for multiplayer synchronization.
 * Pairs two players by on-chain gameId and relays:
 *   - Initial ball state  (P1 → P2 after both connect)
 *   - Shot events         (shooter → opponent)
 *   - Disconnect notices
 *
 * Run: node server.js
 * Default port: 8080  (override with PORT env var)
 */

"use strict";

const path      = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const tournament = require("./tournament");

const http      = require("http");
const WebSocket = require("ws");
const { ethers } = require("ethers");
const crypto    = require("crypto");
const db        = require("./db");
const { simulateShot, sanitizeSnapshot, validateShotParams } = require('./physics.js');


const PORT = process.env.PORT || 8080;

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Fixed-window rate limiter. Returns false when the caller exceeds the quota.
function _createRateLimiter(max, windowMs) {
  const store = new Map(); // ip → { count, resetAt }
  return function(ip) {
    const now = Date.now();
    let entry = store.get(ip);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(ip, entry);
    }
    entry.count++;
    return entry.count <= max;
  };
}

function _clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? fwd.split(",")[0] : req.socket.remoteAddress || "").trim();
}

const _TOO_MANY_JSON = JSON.stringify({ error: "Too many requests, please try again later" });

const _limitGeneral  = _createRateLimiter(100, 15 * 60 * 1000); // 100 / 15 min
const _limitRegister = _createRateLimiter(30,  60 * 60 * 1000); //  30 / 1 h
const _limitAlias    = _createRateLimiter(10,  60 * 60 * 1000); //  10 / 1 h
const _limitMatch    = _createRateLimiter(30,  15 * 60 * 1000); //  30 / 15 min
const _limitClaim      = _createRateLimiter(30,  15 * 60 * 1000); //  30 / 15 min
const _limitTableClaim = _createRateLimiter(5,   60 * 1000);      //   5 / 1 min

// ── On-chain settlement ───────────────────────────────────────────────────────

const PENGPOOL_ADDRESS      = "0x1E27Ff0Ca71e8284437d8a64705ecbd23C8e0922";
const PENGPOOL_DEPLOY_BLOCK = 17180000; // Abstract Testnet block just before deploy
const TABLE_NFT_CONTRACT    = "0x84f038171F43c065d28A47bb1E15f33a4C7BF455";
const TABLE_NFT_LEVELS      = [10, 20, 30, 40, 50]; // required player level per tokenId 0-4
const DECLARE_ABI = [
  "function declareWinner(uint256 matchId, address winner) external",
  "function matchPlayers(address addr1, address addr2, uint8 betUSD) external returns (uint256 matchId)",
  "function cancelMatch(uint256 matchId) external",
  "event MatchCreated(uint256 indexed matchId, address indexed player1, address indexed player2, uint256 betAmount, uint8 betUSD)",
  "event WinnerDeclared(uint256 indexed matchId, address indexed winner)",
  "event MatchCancelled(uint256 indexed matchId, address player1, address player2, uint256 amount)",
];

let _contract = null;


function _getContract() {
  if (_contract) return _contract;
  const key = process.env.PRIVATE_KEY;
  const rpc = process.env.RPC_URL || "https://api.testnet.abs.xyz";
  if (!key) { console.warn("[settle] PRIVATE_KEY not set in .env — on-chain settlement disabled"); return null; }
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet   = new ethers.Wallet(key, provider);
  _contract = new ethers.Contract(PENGPOOL_ADDRESS, DECLARE_ABI, wallet);
  console.log(`[settle] Wallet ready: ${wallet.address}`);
  return _contract;
}

let _wallet   = null;
let _provider = null;

function _getWalletAndProvider() {
  if (_wallet && _provider) return { wallet: _wallet, provider: _provider };
  const key = process.env.PRIVATE_KEY;
  const rpc = process.env.RPC_URL || "https://api.testnet.abs.xyz";
  if (!key) { console.warn("[wallet] PRIVATE_KEY not set — tournament module disabled"); return null; }
  _provider = new ethers.JsonRpcProvider(rpc);
  _wallet   = new ethers.Wallet(key, _provider);
  return { wallet: _wallet, provider: _provider };
}


const TABLE_NFT_MINT_ABI = [
  "function claim(address _receiver, uint256 _tokenId, uint256 _quantity, address _currency, uint256 _pricePerToken, tuple(bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) _allowlistProof, bytes _data) external payable"
];
const TABLE_NFT_BALANCE_ABI = ["function balanceOf(address account, uint256 id) external view returns (uint256)"];
let _nftContract = null;
function _getNFTContract() {
  if (_nftContract) return _nftContract;
  const wp = _getWalletAndProvider();
  if (!wp) return null;
  _nftContract = new ethers.Contract(TABLE_NFT_CONTRACT, TABLE_NFT_MINT_ABI, wp.wallet);
  return _nftContract;
}

// gameIds already settled or in-progress — avoid double-settling
const _settling = new Set();

async function _settle(gameId, winnerAddress, room) {
  const key = String(gameId);
  if (_settling.has(key)) { console.log(`[settle] game ${gameId} already settling, skipping`); return; }
  _settling.add(key);

  if (room.p1addr) settlingAddrs.add(room.p1addr.toLowerCase());
  if (room.p2addr) settlingAddrs.add(room.p2addr.toLowerCase());

  const contract = _getContract();
  if (!contract) {
    _broadcastRoom(room, { type: "settled", error: "Server wallet not configured" });
    settlingAddrs.delete(room.p1addr?.toLowerCase());
    settlingAddrs.delete(room.p2addr?.toLowerCase());
    return;
  }

  console.log(`[settle] Declaring winner for game ${gameId} → ${winnerAddress}`);
  try {
    const tx = await contract.declareWinner(BigInt(gameId), winnerAddress);
    console.log(`[settle] tx sent: ${tx.hash}`);
    await tx.wait();
    console.log(`[settle] game ${gameId} confirmed`);
    _broadcastRoom(room, { type: "settled", txHash: tx.hash, gameId, winnerNum: room.winnerNum });
    console.log('[settle] room.betUSD =', room.betUSD, '| room.matchId =', room.matchId);
    const existing = pendingClaims.get(winnerAddress.toLowerCase()) || [];
    existing.push({ matchId: gameId, betUSD: room.betUSD });
    pendingClaims.set(winnerAddress.toLowerCase(), existing);
    settlingAddrs.delete(room.p1addr?.toLowerCase());
    settlingAddrs.delete(room.p2addr?.toLowerCase());
    rooms.delete(String(gameId));
  } catch (err) {
    const msg = err.shortMessage || err.message || String(err);
    console.error(`[settle] game ${gameId} failed:`, msg);
    _broadcastRoom(room, { type: "settled", error: msg, gameId });
    _settling.delete(key); // allow retry if transient error
    settlingAddrs.delete(room.p1addr?.toLowerCase());
    settlingAddrs.delete(room.p2addr?.toLowerCase());
    rooms.delete(String(gameId));
  }
}

function _broadcastRoom(room, obj) {
  _send(room.p1, obj);
  _send(room.p2, obj);
}

// Determines the winner from the last authoritative game state snapshot.
// FUTURE HOOK: when the server simulates its own physics, replace room.gameState
// with server-computed state here. The call sites and interface stay unchanged.
function serverDetermineWinner(gameState, claimedWinnerNum, reason) {
  if (!gameState || !gameState.balls) return null;

  const balls     = gameState.balls;
  const eightBall = balls.find(b => b.id === 8);
  const cueBall   = balls.find(b => b.id === 0);

  // If the 8-ball is not pocketed, the gameover is invalid
  if (!eightBall || !eightBall.out) return null;

  // Scratch on the 8 — server can verify via cueBall.out
  if (cueBall && cueBall.out) {
    return gameState.cur === 1 ? 2 : 1;
  }

  // Cases the server cannot verify with physics alone (pocket rule, early 8):
  // trust claimedWinnerNum from the client
  const clientReason = (reason || '').toLowerCase();
  const isSpecialCase =
    clientReason.includes('too early') ||
    clientReason.includes('wrong pocket');

  if (isSpecialCase) {
    console.log(`[validate] special case "${reason}" — trusting client winnerNum: ${claimedWinnerNum}`);
    return claimedWinnerNum ?? null;
  }

  // Clean 8-ball pot — shooter wins
  return gameState.cur === 1 ? 1 : 2;
}

function serverValidateLastShot(room) {
  // Primero verificar si el gameState ya refleja el 8 embocado
  // Esto cubre el caso donde result{} llega antes que gameover
  if (room.gameState?.balls) {
    const eightInState = room.gameState.balls.find(b => b.id === 8);
    if (eightInState?.out === true) {
      console.log('[validate] 8-ball confirmed out in gameState — valid');
      return { valid: true, reason: 'eight_in_gamestate' };
    }
  }

  // Si gameState no lo confirma, intentar con simulación
  if (!room.lastShotInput) {
    console.warn('[validate] no lastShotInput and 8-ball not in gameState — rejecting');
    return { valid: false, reason: 'no_data' };
  }

  const { angle, power, spinX, spinY, ballsSnapshot } = room.lastShotInput;

  if (!ballsSnapshot || ballsSnapshot.length === 0) {
    console.warn('[validate] no ballsSnapshot — rejecting');
    return { valid: false, reason: 'no_snapshot' };
  }

  let simResult;
  try {
    simResult = simulateShot(ballsSnapshot, angle, power, spinX ?? 0, spinY ?? 0);
  } catch (err) {
    console.error('[validate] simulateShot threw:', err.message);
    return { valid: true, reason: 'sim_error' };
  }

  if (simResult.timedOut) {
    console.warn('[validate] simulation timed out — accepting');
    return { valid: true, reason: 'sim_timeout' };
  }

  const eightBall = simResult.balls.find(b => b.id === 8);
  const cueBall   = simResult.balls.find(b => b.id === 0);
  const eightOut  = eightBall?.out === true;
  const cueOut    = cueBall?.out   === true;

  if (!eightOut) {
    console.warn('[validate] 8-ball not pocketed in simulation — rejecting');
  }

  return {
    valid: eightOut,
    eightOut,
    cueOut,
    steps: simResult.steps,
    reason: eightOut ? 'eight_pocketed_sim' : 'eight_not_pocketed'
  };
}

function makeInitialBalls() {
  const H   = 500;
  const R   = 11;
  const S   = Math.sin(Math.PI / 3);
  const spx = Math.sqrt(3) * R * 1.05;
  const spy = R / S;
  const rx  = 525, ry = H / 2;
  const RACK = [1, 9, 10, 2, 8, 3, 11, 4, 12, 13, 5, 14, 6, 15, 7];
  const pos  = [
    [0,  0    ], [1, -S    ], [1,  S    ],
    [2, -2*S  ], [2,  0    ], [2,  2*S  ],
    [3, -3*S  ], [3, -S    ], [3,  S    ], [3,  3*S  ],
    [4, -4*S  ], [4, -2*S  ], [4,  0    ], [4,  2*S  ], [4,  4*S  ],
  ];
  const balls = [];
  balls.push({ id: 0, x: 223, y: ry, vx: 0, vy: 0, out: false });
  for (let i = 0; i < 15; i++) {
    const id = RACK[i];
    const [px, py] = pos[i];
    balls.push({ id, x: rx + px * spx, y: ry + py * spy, vx: 0, vy: 0, out: false });
  }
  return balls;
}

// ── computeGameLogic ──────────────────────────────────────────────────────────
// Derives the new game-state fields (turn, types, bonuses, ball-in-hand) from
// the simulation result.  Replicates the pocketed() callback + shotEnd() logic
// that lives in game.js, so the server is fully authoritative on game rules.
//
// prevState    : room.gameState before this shot (null on first shot)
// preShotBalls : sanitized snapshot used for simulation
// simResult    : return value of simulateShot()
// isBreakShot  : true only on the very first shot of the game
function computeGameLogic(prevState, preShotBalls, simResult, isBreakShot) {
  const newBalls       = simResult.balls;
  const pocketedInfo   = simResult.pocketedInfo || {};
  const firstContactId = simResult.firstContactId;

  // Pull previous state (or defaults for the first shot)
  let cur           = prevState?.cur    ?? 1;
  let typed         = prevState?.typed  ?? false;
  let p1T           = prevState?.p1T    ?? null;
  let p2T           = prevState?.p2T    ?? null;
  let p1t           = (prevState?.p1t   ?? []).slice();
  let p2t           = (prevState?.p2t   ?? []).slice();
  let bonusShots    = prevState?.bonusShots ?? 0;
  let ballInHand    = false;
  let p1EightPocket = prevState?.p1EightPocket ?? null;
  let p2EightPocket = prevState?.p2EightPocket ?? null;

  // ── Detect newly pocketed balls ───────────────────────────────────────────
  const preShotMap = {};
  for (const b of preShotBalls) preShotMap[b.id] = b;
  const newlyPocketed = newBalls.filter(b => b.out && !preShotMap[b.id]?.out);
  const cuePocketed   = newlyPocketed.some(b => b.id === 0);
  const eightPocketed = newlyPocketed.some(b => b.id === 8);
  const otherPocketed = newlyPocketed.filter(b => b.id !== 0 && b.id !== 8);

  // ── Process object balls — replicates pocketed() in game.js ──────────────
  let anyP         = false;
  let foulThisTurn = false;

  for (const b of otherPocketed) {
    anyP = true;

    // Assign ball types on the first pocketed object ball
    if (!typed) {
      typed = true;
      const sol = b.id <= 7;
      p1T = cur === 1 ? (sol ? 'solid' : 'stripe') : (sol ? 'stripe' : 'solid');
      p2T = p1T === 'solid' ? 'stripe' : 'solid';
    }

    const sol  = b.id <= 7;
    const mine = (cur === 1 && ((p1T === 'solid' && sol) || (p1T === 'stripe' && !sol))) ||
                 (cur === 2 && ((p2T === 'solid' && sol) || (p2T === 'stripe' && !sol)));

    if (mine) {
      (cur === 1 ? p1t : p2t).push(b.id);
    } else if (!isBreakShot) {
      // Wrong ball pocketed (not on break shot) → foul
      foulThisTurn = true;
      if (typed) {
        const other    = cur === 1 ? 2 : 1;
        const otherT   = other === 1 ? p1T : p2T;
        const otherGrp = otherT === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
        if (otherGrp.includes(b.id)) {
          (other === 1 ? p1t : p2t).push(b.id);
        }
      }
    }
  }

  // ── p1/p2 EightPocket — record pocket when player clears their last ball ──
  if (typed && p1T && p2T) {
    const myGroup       = cur === 1
      ? (p1T === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15])
      : (p2T === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15]);
    const remainBefore  = preShotBalls.filter(pb => !pb.out && myGroup.includes(pb.id));
    const remainAfter   = newBalls.filter(nb  => !nb.out  && myGroup.includes(nb.id));
    if (remainBefore.length > 0 && remainAfter.length === 0) {
      const lastOwn = otherPocketed.find(b => {
        const sol = b.id <= 7;
        return (cur === 1 && ((p1T === 'solid' && sol) || (p1T === 'stripe' && !sol))) ||
               (cur === 2 && ((p2T === 'solid' && sol) || (p2T === 'stripe' && !sol)));
      });
      if (lastOwn != null && pocketedInfo[lastOwn.id] != null) {
        if (cur === 1) p1EightPocket = pocketedInfo[lastOwn.id];
        else           p2EightPocket = pocketedInfo[lastOwn.id];
      }
    }
  }

  // ── First-contact foul — replicates shotEnd() check in game.js ───────────
  if (!cuePocketed && !foulThisTurn && !isBreakShot) {
    if (firstContactId === null) {
      foulThisTurn = true;
    } else if (typed && p1T && p2T) {
      const myType      = cur === 1 ? p1T : p2T;
      const myGroup     = myType === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
      const preShotOwn  = preShotBalls.filter(pb => !pb.out && myGroup.includes(pb.id));
      if (preShotOwn.length === 0) {
        if (firstContactId !== 8) foulThisTurn = true;
      } else {
        const fcSolid  = firstContactId >= 1 && firstContactId <= 7;
        const fcStripe = firstContactId >= 9 && firstContactId <= 15;
        const fcMine   = (myType === 'solid' && fcSolid) || (myType === 'stripe' && fcStripe);
        const myBallsAfter        = newBalls.filter(nb => !nb.out && myGroup.includes(nb.id));
        const clearedGroupThisTurn = myBallsAfter.length === 0;
        if (!fcMine && !(clearedGroupThisTurn && firstContactId === 8)) foulThisTurn = true;
      }
    } else {
      if (firstContactId === 8) foulThisTurn = true;
    }
  }

  // ── Bonus-shot tracking ───────────────────────────────────────────────────
  const hadBonus = bonusShots > 0;
  if (hadBonus) bonusShots--;

  // ── Turn result — replicates the turn-switching block in shotEnd() ────────
  if (cuePocketed) {
    if (!eightPocketed) bonusShots = 2;
    ballInHand = true;
    cur = cur === 1 ? 2 : 1;
    const cueBall = newBalls.find(b => b.id === 0);
    if (cueBall) { cueBall.out = false; cueBall.x = 223; cueBall.y = 250; cueBall.vx = 0; cueBall.vy = 0; }
  } else if (foulThisTurn) {
    bonusShots = 2;
    cur = cur === 1 ? 2 : 1;
  } else if (hadBonus && bonusShots > 0) {
    // Keep turn — consumed one bonus, still more remaining
  } else if (anyP) {
    bonusShots = 0;
    // Keep turn — pocketed a legal ball
  } else {
    bonusShots = 0;
    cur = cur === 1 ? 2 : 1;
  }

  return { cur, typed, p1T, p2T, p1t, p2t, bonusShots, ballInHand, p1EightPocket, p2EightPocket };
}

function _resolveGameover(gameId, room, winnerNum, originalMsg) {
  console.log(`[settle] gameId: ${gameId} | winner: P${winnerNum}`);
  if (_settling.has(String(gameId))) return; // guard double-resolve

  const winnerAddr = winnerNum === 1 ? room.p1addr : room.p2addr;
  const loserAddr  = winnerNum === 1 ? room.p2addr : room.p1addr;
  const ZERO = "0x0000000000000000000000000000000000000000";

  // Record PvP result in DB for both players (fire-and-forget)
  if (winnerAddr && winnerAddr !== ZERO) {
    db.recordGameResult(winnerAddr, true).catch(e =>
      console.error(`[db] game-result winner P${winnerNum}:`, e.message));
  }
  if (loserAddr && loserAddr !== ZERO) {
    db.recordGameResult(loserAddr, false).catch(e =>
      console.error(`[db] game-result loser:`, e.message));
  }

  if (!winnerAddr || winnerAddr === ZERO) {
    console.warn(`[settle] game ${gameId}: no address for winner P${winnerNum}`);
    return;
  }

  // Tournament rooms: route to tournament handler, skip PvP settlement
  if (room.isTournament) {
    tournament.handleMatchResult(String(gameId), winnerAddr, loserAddr);
    return;
  }

  room.winnerNum = winnerNum;
  _settle(gameId, winnerAddr, room);
}

async function _matchOnChain(addr1, addr2, betUSD) {
  try {
    if (!_contract) _getContract();
    console.log(`[mm] matchPlayers on-chain: ${addr1} vs ${addr2} ($${betUSD})`);
    const tx      = await _contract.matchPlayers(addr1, addr2, Number(betUSD));
    const receipt = await tx.wait();
    // Parse MatchCreated event to get matchId
    const iface   = new ethers.Interface(DECLARE_ABI);
    let matchId   = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === 'MatchCreated') {
          matchId = parsed.args.matchId.toString();
          break;
        }
      } catch(_) {}
    }
    console.log(`[mm] matchPlayers confirmed — matchId: ${matchId} tx: ${tx.hash}`);
    return matchId;
  } catch(e) {
    console.error('[mm] matchPlayers failed:', e.message);
    throw e;
  }
}

// ── Orphan resolver ───────────────────────────────────────────────────────────
// Blocks WebSocket joins until this flag is set to true after startup resolution.
let _serverReady = false;

async function _resolveOrphanedMatches() {
  const contract = _getContract();
  if (!contract) {
    console.warn("[OrphanResolver] PRIVATE_KEY not set — skipping orphan resolution");
    return;
  }

  console.log("[OrphanResolver] Starting orphan match resolution...");

  try {
    const provider   = contract.runner.provider;
    const toBlock    = await provider.getBlockNumber();
    const fromBlock  = Math.max(0, toBlock - 10000);
    const iface      = new ethers.Interface(DECLARE_ABI);

    console.log(`[OrphanResolver] Querying last 10 000 blocks (${fromBlock}–${toBlock})`);

    const [createdLogs, declaredLogs, cancelledLogs] = await Promise.all([
      provider.getLogs({ address: PENGPOOL_ADDRESS, topics: [iface.getEvent("MatchCreated").topicHash],   fromBlock, toBlock }),
      provider.getLogs({ address: PENGPOOL_ADDRESS, topics: [iface.getEvent("WinnerDeclared").topicHash], fromBlock, toBlock }),
      provider.getLogs({ address: PENGPOOL_ADDRESS, topics: [iface.getEvent("MatchCancelled").topicHash], fromBlock, toBlock }),
    ]);

    const _parseId = log => iface.parseLog(log).args.matchId.toString();

    const created   = new Set(createdLogs.map(_parseId));
    const declared  = new Set(declaredLogs.map(_parseId));
    const cancelled = new Set(cancelledLogs.map(_parseId));
    const orphans   = [...created].filter(id => !declared.has(id) && !cancelled.has(id));

    console.log(
      `[OrphanResolver] created=${created.size} declared=${declared.size}` +
      ` cancelled=${cancelled.size} orphaned=${orphans.length}`
    );

    for (const matchId of orphans) {
      try {
        console.log(`[OrphanResolver] Cancelling match ${matchId}...`);
        const tx      = await contract.cancelMatch(BigInt(matchId));
        const receipt = await tx.wait();
        console.log(`[OrphanResolver] Match ${matchId} cancelled — tx: ${receipt.hash}`);
      } catch (err) {
        console.error(`[OrphanResolver] Failed to cancel match ${matchId}:`, err.shortMessage || err.message);
      }
    }

    if (orphans.length === 0) console.log("[OrphanResolver] No orphaned matches found.");
    console.log("[OrphanResolver] Done.");
  } catch (err) {
    console.error("[OrphanResolver] Error during resolution:", err.message);
  }
}

// rooms: Map<gameId:string, { p1, p2, p1addr, p2addr, p1alias, p2alias }>
const rooms = new Map();

// Global alias registry: addr.toLowerCase() → alias
const aliases = new Map();

// ── Matchmaking queues ─────────────────────────────────────────────────
// Map<addr, { ws, addr, alias, level, betUSD, joinedAt, range }>
const mmQueues = { '1': new Map(), '5': new Map() };

// addr.toLowerCase() → { matchId, opponentAddr, opponentAlias, playerNum, betUSD }
const pendingMatches = new Map();

// addr.toLowerCase() → { matchId, betUSD }
const pendingClaims = new Map();

// addresses blocked while _settle() is in-flight
const settlingAddrs = new Set();

// Broadcast queue counts to all players in queue
function _broadcastQueueCounts() {
  const counts = { '1': mmQueues['1'].size, '5': mmQueues['5'].size };
  for (const q of Object.values(mmQueues)) {
    for (const entry of q.values()) {
      _send(entry.ws, { type: 'mm_queue_counts', counts });
    }
  }
}

// Try to match two players in a queue
async function _tryMatch(betKey) {
  const queue = mmQueues[betKey];
  // Purge zombie entries whose WebSocket closed without a close event
  for (const [addr, entry] of queue) {
    if (entry.ws.readyState !== WebSocket.OPEN) {
      queue.delete(addr);
    }
  }
  if (queue.size < 2) return;
  const entries = Array.from(queue.values());
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i], b = entries[j];
      const range = Math.min(a.range, b.range);
      if (Math.abs(a.level - b.level) <= range) {
        // Skip any candidate whose settle is still in-flight
        if (settlingAddrs.has(a.addr.toLowerCase())) continue;
        if (settlingAddrs.has(b.addr.toLowerCase())) continue;
        // Found a match — remove both from queue
        queue.delete(a.addr);
        queue.delete(b.addr);
        // Randomly assign P1/P2
        const [p1, p2] = Math.random() < 0.5 ? [a, b] : [b, a];
        // Call matchPlayers on-chain and wait for confirmation
        let matchId = null;
        try {
          matchId = await _matchOnChain(p1.addr, p2.addr, betKey);
        } catch(err) {
          console.error('[mm] on-chain match failed:', err.message);
          const errMsg = (err.shortMessage || err.message || '').toLowerCase();
          const isDepositError = errMsg.includes('no valid deposit') || errMsg.includes('deposit');
          if (isDepositError) {
            // Try to identify which player's deposit failed.
            // Contract reverts on the first invalid deposit it checks (p1 first, then p2).
            // Heuristic: revert data mentioning addr helps, otherwise assume p2 failed
            // since p1 is checked first and a p1 failure would revert before reaching p2.
            const p1AddrLower = p1.addr.toLowerCase();
            const p2AddrLower = p2.addr.toLowerCase();
            const errStr = err.message || '';
            const p1Mentioned = errStr.toLowerCase().includes(p1AddrLower.slice(2, 10));
            const p2Mentioned = errStr.toLowerCase().includes(p2AddrLower.slice(2, 10));

            let depositFailedPlayer = null;
            if (p1Mentioned && !p2Mentioned) depositFailedPlayer = 'p1';
            else if (p2Mentioned && !p1Mentioned) depositFailedPlayer = 'p2';
            // If ambiguous, send mm_requeue to both

            if (depositFailedPlayer === 'p1') {
              console.log(`[mm] deposit failed for P1 (${p1.addr.slice(0,8)}…) — keeping P2 in queue`);
              _send(p1.ws, { type: 'mm_error', reason: 'deposit_not_found' });
              _send(p2.ws, { type: 'mm_requeue', reason: 'opponent_deposit_failed' });
              mmQueues[betKey].set(p2.addr, { ...p2, range: p2.range });
            } else if (depositFailedPlayer === 'p2') {
              console.log(`[mm] deposit failed for P2 (${p2.addr.slice(0,8)}…) — keeping P1 in queue`);
              _send(p2.ws, { type: 'mm_error', reason: 'deposit_not_found' });
              _send(p1.ws, { type: 'mm_requeue', reason: 'opponent_deposit_failed' });
              mmQueues[betKey].set(p1.addr, { ...p1, range: p1.range });
            } else {
              console.log('[mm] deposit error — cannot identify which player, requeuing both');
              _send(p1.ws, { type: 'mm_requeue', reason: 'opponent_deposit_failed' });
              _send(p2.ws, { type: 'mm_requeue', reason: 'opponent_deposit_failed' });
              mmQueues[betKey].set(p1.addr, { ...p1, range: p1.range });
              mmQueues[betKey].set(p2.addr, { ...p2, range: p2.range });
            }
          } else {
            // Generic failure — requeue both
            console.log('[mm] generic match failure — requeuing both players');
            _send(p1.ws, { type: 'mm_requeue', reason: 'match_failed' });
            _send(p2.ws, { type: 'mm_requeue', reason: 'match_failed' });
            mmQueues[betKey].set(p1.addr, { ...p1, range: p1.range });
            mmQueues[betKey].set(p2.addr, { ...p2, range: p2.range });
          }
          _broadcastQueueCounts();
          return;
        }
        // On-chain confirmed — notify players
        console.log(`[mm] Match confirmed on-chain matchId=${matchId} ($${betKey}): ${p1.alias} vs ${p2.alias}`);
        pendingMatches.set(p1.addr.toLowerCase(), { matchId, opponentAddr: p2.addr, opponentAlias: p2.alias, playerNum: 1, betUSD: betKey });
        pendingMatches.set(p2.addr.toLowerCase(), { matchId, opponentAddr: p1.addr, opponentAlias: p1.alias, playerNum: 2, betUSD: betKey });
        _send(p1.ws, { type: 'mm_you_are_p1', betUSD: betKey, opponentAlias: p2.alias, opponentAddr: p2.addr, matchId });
        _send(p2.ws, { type: 'mm_join_game',  betUSD: betKey, opponentAlias: p1.alias, opponentAddr: p1.addr, matchId });
        p1.ws._mmMatchId = matchId;
        p2.ws._mmMatchId = matchId;
        p1.ws._mmBetUSD  = betKey;
        p2.ws._mmBetUSD  = betKey;
        // Store pending match so P1 can report gameId
        p1.ws._mmPendingP2 = p2;
        p2.ws._mmWaitingForGameId = true;
        _broadcastQueueCounts();
        return;
      }
    }
  }
}

// Expand ranges every 15s and try matching
setInterval(() => {
  for (const [betKey, queue] of Object.entries(mmQueues)) {
    for (const entry of queue.values()) {
      if (entry.range < 15) entry.range = Math.min(15, entry.range + 2);
    }
    _tryMatch(betKey);
  }
}, 15000);

const CORS = { "Access-Control-Allow-Origin": "*" };

function _readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  // Guard: catch any unhandled async error so the server process never crashes.
  // Without this, a rejected await (e.g. client disconnects mid-request while the
  // DB query is still running) becomes an unhandled promise rejection that kills
  // the Node.js 15+ process, dropping all active WebSocket connections mid-game.
  const _safeEnd = (status, headers, body) => {
    try {
      if (!res.headersSent) { res.writeHead(status, headers); res.end(body); }
    } catch (_) {}
  };

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Content-Type" });
      res.end(); return;
    }

    // ── Rate limiting ─────────────────────────────────────────────────────────
    const _ip = _clientIp(req);
    if (!_limitGeneral(_ip)) {
      _safeEnd(429, { "Content-Type": "application/json", ...CORS }, _TOO_MANY_JSON); return;
    }

    // ── existing alias endpoints ──────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/aliases") {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(Object.fromEntries(aliases))); return;
    }
    if (req.method === "POST" && req.url === "/alias") {
      if (!_limitAlias(_ip)) { _safeEnd(429, { "Content-Type": "application/json", ...CORS }, _TOO_MANY_JSON); return; }
      const body = await _readBody(req);
      try {
        const { addr, alias } = JSON.parse(body);
        if (addr && alias) aliases.set(addr.toLowerCase(), String(alias).slice(0, 20));
      } catch {}
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS });
      res.end("OK"); return;
    }

    // ── leaderboard ───────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url.startsWith("/api/leaderboard")) {
      const qs   = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
      const wallet = new URLSearchParams(qs).get("wallet") || null;
      try {
        const data = await db.getLeaderboard(wallet);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify(data));
      } catch (e) {
        console.error("[api] leaderboard:", e.message);
        _safeEnd(500, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── player profile API ────────────────────────────────────────────────────
    if (req.method === "GET" && req.url.startsWith("/api/player/")) {
      const wallet = decodeURIComponent(req.url.slice("/api/player/".length));
      try {
        const player = await db.getPlayer(wallet);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify(player || null));
      } catch (e) {
        console.error("[api] getPlayer:", e.message);
        _safeEnd(500, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/player/register") {
      if (!_limitRegister(_ip)) { _safeEnd(429, { "Content-Type": "application/json", ...CORS }, _TOO_MANY_JSON); return; }
      try {
        const { wallet, username } = JSON.parse(await _readBody(req));
        console.log(`[api] register wallet=${wallet?.slice(0,10)}… username="${username}"`);
        const player = await db.registerPlayer(wallet, username);
        console.log(`[api] register OK → level=${player.level} pts=${player.points}`);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify(player));
      } catch (e) {
        console.log(`[api] register FAILED: ${e.message}`);
        _safeEnd(400, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: e.message }));
      }
      return;
    }
    if (req.method === "POST" && req.url === "/api/player/rename") {
      try {
        const { wallet, username } = JSON.parse(await _readBody(req));
        const player = await db.renamePlayer(wallet, username);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify(player));
      } catch (e) {
        _safeEnd(400, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: e.message }));
      }
      return;
    }
    // ── game-status  (check if a room is still active) ───────────────────────
    if (req.method === "GET" && req.url.startsWith("/api/game-status/")) {
      const rawId  = req.url.slice("/api/game-status/".length);
      const numId  = Number(rawId);
      const strId  = String(rawId);
      console.log('[game-status] checking gameId:', strId, '| rooms has str:', rooms.has(strId), '| rooms has num:', rooms.has(numId), '| all room keys:', [...rooms.keys()]);
      const active = rooms.has(strId) || rooms.has(numId);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ active }));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/pending-match/")) {
      if (!_limitMatch(_ip)) { _safeEnd(429, { "Content-Type": "application/json", ...CORS }, _TOO_MANY_JSON); return; }
      const addr  = req.url.slice("/api/pending-match/".length).toLowerCase();
      const match = pendingMatches.get(addr);
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(match ? { found: true, ...match } : { found: false }));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/player-status/")) {
      const addr = req.url.slice("/api/player-status/".length).toLowerCase();
      let status = 'ok';
      if (settlingAddrs.has(addr)) {
        status = 'settling';
      } else {
        for (const room of rooms.values()) {
          if (room.p1addr?.toLowerCase() === addr || room.p2addr?.toLowerCase() === addr) {
            status = 'in_room';
            break;
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ status }));
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/pending-claim/")) {
      if (!_limitClaim(_ip)) { _safeEnd(429, { "Content-Type": "application/json", ...CORS }, _TOO_MANY_JSON); return; }
      const addr  = req.url.slice("/api/pending-claim/".length).toLowerCase();
      const claims = pendingClaims.get(addr) || [];
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ found: claims.length > 0, claims }));
      return;
    }

    if (req.method === "DELETE" && req.url.startsWith("/api/pending-claim/")) {
      const addr = req.url.slice("/api/pending-claim/".length).toLowerCase();
      const delBody = await _readBody(req);
      const { matchId: delMatchId } = JSON.parse(delBody);
      const claims = pendingClaims.get(addr) || [];
      const updated = claims.filter(c => String(c.matchId) !== String(delMatchId));
      if (updated.length === 0) {
        pendingClaims.delete(addr);
      } else {
        pendingClaims.set(addr, updated);
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/active-games") {
      const games = [];
      for (const [gameId, room] of rooms) {
        if (!room.p1addr || !room.p2addr) continue;
        games.push({
          gameId,
          p1alias: room.p1alias || room.p1addr.slice(0,6),
          p2alias: room.p2alias || room.p2addr.slice(0,6),
          p1addr:  room.p1addr,
          p2addr:  room.p2addr,
          matchId: room.matchId || null,
          betUSD:  room.betUSD  || null,
        });
      }
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify({ games }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/player/game-result") {
      try {
        const { wallet, won } = JSON.parse(await _readBody(req));
        await db.recordGameResult(wallet, !!won);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        _safeEnd(400, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/request-table-claim") {
      if (!_limitTableClaim(_ip)) { _safeEnd(429, { "Content-Type": "application/json", ...CORS }, _TOO_MANY_JSON); return; }
      try {
        const { wallet, tokenId } = JSON.parse(await _readBody(req));
        const tid = Number(tokenId);
        if (!wallet || !Number.isInteger(tid) || tid < 0 || tid > 4) {
          _safeEnd(400, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: "Invalid request" })); return;
        }
        const player = await db.getPlayer(wallet);
        if (!player) {
          _safeEnd(403, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: "Player not found" })); return;
        }
        const required = TABLE_NFT_LEVELS[tid];
        if (player.level < required) {
          _safeEnd(403, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: `Level ${required} required (you are level ${player.level})` })); return;
        }
        const wp = _getWalletAndProvider();
        if (!wp) {
          _safeEnd(500, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: "Server misconfigured" })); return;
        }

        // Check if player already owns this token
        const nftRead = new ethers.Contract(TABLE_NFT_CONTRACT, TABLE_NFT_BALANCE_ABI, wp.provider);
        const balance = await nftRead.balanceOf(wallet, tid);
        if (balance > 0n) {
          _safeEnd(403, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: "Already owns this table" })); return;
        }

        // Mint via ethers.js
        const nft = _getNFTContract();
        const tx = await nft.claim(
          wallet,
          tid,
          1,
          "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
          0,
          { proof: [], quantityLimitPerWallet: 999999, pricePerToken: 0, currency: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" },
          "0x"
        );
        await tx.wait();
        console.log(`[table-claim] Minted token ${tid} → ${wallet.slice(0,10)}… tx: ${tx.hash}`);
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        console.error(`[table-claim] Error: ${e.message}`);
        _safeEnd(500, { "Content-Type": "application/json", ...CORS }, JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Tournament routes
    for (const route of tournament.httpRoutes) {
      if (route.match(req.method, req.url)) {
        await route.handler(req, res);
        return;
      }
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("PengPool sync OK\n");

  } catch (e) {
    // Last-resort catch: prevents any leaked async error from crashing the process.
    console.error("[http] unhandled error:", e.message);
    _safeEnd(500, { "Content-Type": "text/plain", ...CORS }, "Internal server error");
  }
});

// ── WebSocket ERC-1271 authentication ────────────────────────────────────────
let _authProvider = null;
function _ensureAuthProvider() {
  if (_authProvider) return _authProvider;
  _authProvider = new ethers.JsonRpcProvider(process.env.RPC_URL || "https://api.testnet.abs.xyz");
  return _authProvider;
}

const _ERC1271_ABI   = ["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"];
const _ERC1271_MAGIC = "0x1626ba7e";

// Human-readable auth message shown to the user in the wallet popup
function _authMsg(nonce) {
  return (
    "PengPool Session Login\n\n" +
    "By signing this message you are verifying ownership of your wallet.\n" +
    "This signature does not grant access to your funds or execute any transaction.\n" +
    "Valid for 7 days.\n\n" +
    "Nonce: " + nonce
  );
}

async function _verifyERC1271(addr, message, signature) {
  const provider = _ensureAuthProvider();
  const hash     = ethers.hashMessage(message);
  const contract = new ethers.Contract(addr, _ERC1271_ABI, provider);
  const result   = await Promise.race([
    contract.isValidSignature(hash, signature),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("ERC-1271 timed out")), 8000)
    ),
  ]);
  return result.toLowerCase() === _ERC1271_MAGIC;
}

// Session token store: token → { addr, expiresAt }
const _sessionTokens  = new Map();
const _SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Clean up expired tokens every 30 minutes
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [tok, entry] of _sessionTokens) {
    if (now > entry.expiresAt) { _sessionTokens.delete(tok); removed++; }
  }
  if (removed) console.log(`[auth] token cleanup — removed ${removed}, ${_sessionTokens.size} active`);
  db.pool.query('DELETE FROM session_tokens WHERE expires_at < NOW()')
    .catch(e => console.warn('[auth] DB token cleanup error:', e.message));
}, 30 * 60 * 1000);

// Load persisted tokens from DB into memory on startup
(async () => {
  try {
    const { rows } = await db.pool.query(
      'SELECT token, addr, expires_at FROM session_tokens WHERE expires_at > NOW()'
    );
    for (const r of rows) {
      _sessionTokens.set(r.token, { addr: r.addr, expiresAt: new Date(r.expires_at).getTime() });
    }
    console.log(`[auth] loaded ${rows.length} session tokens from DB`);
  } catch(e) {
    console.warn('[auth] could not load session tokens from DB:', e.message);
  }
})();

const wss = new WebSocket.Server({ server: httpServer });

// Init tournament module
const _wp = _getWalletAndProvider();
if (_wp) {
  tournament.initTournament(wss, db.pool, _wp.wallet, _wp.provider, rooms);
}

wss.on("connection", (ws, req) => {
  ws._ip = _clientIp(req);
  // Block game connections while orphan resolver is still running at startup
  if (!_serverReady) {
    ws.send(JSON.stringify({ type: "server_starting", message: "Server initializing, please retry in a few seconds" }));
    ws.close();
    return;
  }

  ws._gameId        = null;
  ws._playerNum     = null;
  ws._authenticated = false;
  ws._authSkipped   = false;
  ws._msgBuffer     = [];

  // Issue challenge immediately
  const _nonce = crypto.randomBytes(16).toString("hex");
  ws._nonce    = _nonce;
  _send(ws, { type: "auth_challenge", nonce: _nonce });

  // Close if no auth arrives within 15 seconds
  const _authTimer = setTimeout(() => {
    if (!ws._authenticated) {
      console.warn(`[auth] timeout — closing unauthenticated WS (ip: ${ws._ip})`);
      ws.close(1008, "Authentication timeout");
    }
  }, 15000);
  ws.on("close", () => clearTimeout(_authTimer));

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Authentication gate ───────────────────────────────────────────────
    if (!ws._authenticated) {
      if (msg.type === "auth_token") {
        const { addr, token } = msg;
        if (!addr || !token) { ws.close(1008, "Invalid auth_token"); return; }
        let entry = _sessionTokens.get(token);
        if (!entry) {
          try {
            const { rows } = await db.pool.query(
              'SELECT addr, expires_at FROM session_tokens WHERE token = $1', [token]
            );
            if (rows.length) {
              entry = { addr: rows[0].addr, expiresAt: new Date(rows[0].expires_at).getTime() };
              _sessionTokens.set(token, entry); // warm cache
            }
          } catch(e) {
            console.warn('[auth] DB token lookup error:', e.message);
          }
        }
        if (!entry || Date.now() > entry.expiresAt || entry.addr !== addr.toLowerCase()) {
          console.warn(`[auth] invalid/expired token from ${(addr||'').slice(0,8)}…`);
          ws.close(1008, "Invalid or expired session token"); return;
        }
        ws._authenticated = true;
        ws._addr = addr.toLowerCase();
        console.log(`[auth] token auth: ${addr.slice(0,8)}…`);
        _send(ws, { type: 'auth_ok' });
        const tBuf = ws._msgBuffer; ws._msgBuffer = [];
        for (const r of tBuf) process.nextTick(() => ws.emit("message", r));
        return;
      }
      if (msg.type === "auth_response") {
        const { addr, signature } = msg;
        if (!addr || !signature || !ws._nonce) {
          ws.close(1008, "Invalid auth_response"); return;
        }
        const nonce = ws._nonce;
        ws._nonce   = null; // consume — anti-replay
        let valid = false;
        try { valid = await _verifyERC1271(addr, _authMsg(nonce), signature); }
        catch (e) {
          console.warn(`[auth] ERC-1271 error for ${addr.slice(0,8)}…: ${e.message}`);
          ws.close(1008, "Authentication error"); return;
        }
        if (!valid) {
          console.warn(`[auth] signature invalid for ${addr.slice(0,8)}…`);
          ws.close(1008, "Authentication failed"); return;
        }
        ws._authenticated = true;
        ws._addr = addr.toLowerCase();
        // Issue session token so client avoids re-signing on reconnects
        const sessionToken = crypto.randomBytes(32).toString("hex");
        const _expiresAt = Date.now() + _SESSION_TTL_MS;
        _sessionTokens.set(sessionToken, { addr: addr.toLowerCase(), expiresAt: _expiresAt });
        db.pool.query(
          'INSERT INTO session_tokens (token, addr, expires_at) VALUES ($1, $2, $3) ON CONFLICT (token) DO NOTHING',
          [sessionToken, addr.toLowerCase(), new Date(_expiresAt).toISOString()]
        ).catch(e => console.warn('[auth] could not persist session token:', e.message));
        console.log(`[auth] authenticated + token issued: ${addr.slice(0,8)}…`);
        _send(ws, { type: "auth_token_issued", token: sessionToken });
        const buf = ws._msgBuffer; ws._msgBuffer = [];
        for (const r of buf) process.nextTick(() => ws.emit("message", r));
        return;
      }
      if (msg.type === "auth_skip") {
        // Allowed only for spectator joins (playerNum 0) and notif sockets
        ws._authSkipped   = true;
        ws._authenticated = true;
        const buf = ws._msgBuffer; ws._msgBuffer = [];
        for (const r of buf) process.nextTick(() => ws.emit("message", r));
        return;
      }
      // Buffer everything else until auth completes
      ws._msgBuffer.push(raw);
      return;
    }
    // ── End auth gate ─────────────────────────────────────────────────────

    // Sequence validation for in-game messages
    if (ws._gameId && msg.type !== 'join' && msg.seq !== undefined) {
      const room = rooms.get(ws._gameId);
      if (room && ws._playerNum) {
        const seqKey = `p${ws._playerNum}seq`;
        const expected = room[seqKey] || 0;
        if (msg.seq !== expected) {
          console.warn(`[seq] game ${ws._gameId} P${ws._playerNum}: expected seq ${expected}, got ${msg.seq} — dropping msg type=${msg.type}`);
          return;
        }
        room[seqKey]++;
      }
    }

    // ── Matchmaking: join queue ────────────────────────────────────────────
    if (msg.type === 'mm_join_queue') {
      if (ws._authSkipped) { ws.close(1008, "Unauthorized"); return; }
      // Identify the WS connection if not already done
      if (!ws._addr && msg.addr) {
        ws._addr  = msg.addr.toLowerCase();
        ws._alias = msg.alias || (ws._addr ? ws._addr.slice(0, 6) + '\u2026' + ws._addr.slice(-4) : 'Unknown');
        aliases.set(ws._addr, ws._alias);
      }
      if (!ws._addr) { _send(ws, { type: 'mm_error', reason: 'not_identified' }); return; }

      const tableId = (msg.tableId !== null && msg.tableId !== undefined)
        ? Number(msg.tableId) : null;
      if (tableId !== null && Number.isInteger(tableId) && tableId >= 0 && tableId <= 4) {
        try {
          const wp = _getWalletAndProvider();
          if (wp) {
            const nftRead = new ethers.Contract(TABLE_NFT_CONTRACT, TABLE_NFT_BALANCE_ABI, wp.provider);
            const balance = await nftRead.balanceOf(ws._addr, tableId);
            if (balance === 0n) {
              _send(ws, { type: 'mm_error', reason: 'no_table_nft' });
              return;
            }
          }
        } catch (e) {
          console.error('[mm] NFT check failed:', e.message);
          // Fallo abierto: si el RPC falla no bloqueamos al jugador
        }
      }

      const betKey = String(msg.betUSD) === '5' ? '5' : '1';
      const queue  = mmQueues[betKey];
      // Remove from other queue if present
      for (const [bk, q] of Object.entries(mmQueues)) {
        if (bk !== betKey) q.delete(ws._addr);
      }
      queue.set(ws._addr, {
        ws, addr: ws._addr, alias: ws._alias || ws._addr,
        level: (() => { const l = Number(msg.level); return (isFinite(l) && l >= 0 && l <= 1000) ? l : 1; })(),
        betUSD: betKey, joinedAt: Date.now(), range: 5
      });
      console.log(`[mm] ${ws._alias} joined $${betKey} queue (level ${msg.level}) — queue size: ${queue.size}`);
      _send(ws, { type: 'mm_queue_joined', betUSD: betKey });
      _broadcastQueueCounts();
      _tryMatch(betKey);
      return;
    }

    // ── Matchmaking: leave queue ───────────────────────────────────────────
    if (msg.type === 'mm_leave_queue') {
      for (const q of Object.values(mmQueues)) q.delete(ws._addr);
      // If this player was matched and P2 is waiting, notify P2
      if (ws._mmPendingP2) {
        _send(ws._mmPendingP2.ws, { type: 'mm_match_cancelled', reason: 'opponent_left' });
        ws._mmPendingP2 = null;
      }
      _send(ws, { type: 'mm_queue_left' });
      _broadcastQueueCounts();
      return;
    }

    // ── Matchmaking: P1 reports gameId after creating on-chain ────────────
    if (msg.type === 'mm_game_created') {
      const p2 = ws._mmPendingP2;
      if (!p2) return;
      ws._mmPendingP2 = null;
      if (!/^\d+$/.test(String(msg.gameId))) return;
      const gameId = String(msg.gameId);
      console.log(`[mm] P1 created game ${gameId} — notifying P2`);
      _send(p2.ws, { type: 'mm_join_game', gameId, opponentAlias: ws._alias, opponentAddr: ws._addr });
      return;
    }

    // ── join ──────────────────────────────────────────────────────────────
    if (msg.type === "join") {
      const _gid = String(msg.gameId);
      if (!/^\d+$/.test(_gid) && !_gid.startsWith('notif_') && !/^t_\d+_\d+$/.test(_gid)) return;
      const gameId = String(msg.gameId);
      const addr   = (msg.addr || "").toLowerCase();

      // auth_skip connections may only be spectators (playerNum 0) or notif sockets
      if (ws._authSkipped && msg.playerNum !== 0 && !gameId.startsWith('notif_')) {
        console.warn(`[auth] auth_skip attempted non-exempt join from ${addr.slice(0,8)}… — closing`);
        ws.close(1008, "Unauthorized"); return;
      }

      // Notification-only socket — just register addr for tournament WS pushes
      if (gameId.startsWith('notif_')) {
        ws._addr = addr;
        ws._alias = msg.alias || '';
        console.log(`[notif] registered notification socket for ${addr.slice(0,8)}…`);
        return;
      }

      // ── Reconnection: wallet already belongs to this room ─────────────
      if (rooms.has(gameId)) {
        const room = rooms.get(gameId);
        const pNum = room.p1addr?.toLowerCase() === addr ? 1
                   : room.p2addr?.toLowerCase() === addr ? 2
                   : null;
        if (pNum !== null) {
          // Tournament room first join — treat as fresh connect, not reconnect
          if (room.isTournament && !room.gameState) {
            // Fall through to normal join flow below
          } else {
          // Cancel pending disconnect timer
          const timerKey = `p${pNum}timer`;
          const cdKey    = `p${pNum}cd`;
          if (room[timerKey]) { clearTimeout(room[timerKey]);  room[timerKey] = null; }
          if (room[cdKey])    { clearInterval(room[cdKey]);    room[cdKey]    = null; }

          // Restore socket
          ws._gameId    = gameId;
          ws._playerNum = pNum;
          ws._addr      = msg.addr || "";
          ws._alias     = msg.alias || "";
          room[`p${pNum}`] = ws;
          room[`p${pNum}seq`] = 0; // reset sequence on reconnect
          console.log(`[room ${gameId}] P${pNum} reconnected (${addr.slice(0,8)}…)`);

          // Ask the active player to send their current state (source of truth).
          // Store the reconnecting ws so sync_state handler knows where to forward it.
          const other = pNum === 1 ? room.p2 : room.p1;
          if (other && other.readyState === 1 /* OPEN */) {
            room.pendingRejoinWs = ws;
            _send(other, { type: "request_state" });
            room.pendingRejoinTimeout = setTimeout(() => {
              if (room.pendingRejoinWs) {
                _send(room.pendingRejoinWs, {
                  type:      'rejoin_state',
                  gameState: room.gameState || null,
                  p1alias:   room.p1alias, p2alias: room.p2alias,
                  p1addr:    room.p1addr,  p2addr:  room.p2addr
                });
                room.pendingRejoinWs = null;
              }
            }, 3000);
          } else {
            // Other player not connected — fall back to cached state
            _send(ws, {
              type:      "rejoin_state",
              gameState: room.gameState || null,
              p1alias:   room.p1alias || null,
              p2alias:   room.p2alias || null,
              p1addr:    room.p1addr  || null,
              p2addr:    room.p2addr  || null
            });
          }
          // Notify both that the connection is restored
          _send(ws,    { type: "opponent_reconnected" });
          _send(other, { type: "opponent_reconnected" });
          return;
          } // end tournament fresh-join bypass
        }
      }

      // Reject if this wallet is already connected in a different room
      if (addr) {
        for (const [existingId, existingRoom] of rooms) {
          if (existingId === gameId) continue;
          if (existingRoom.p1addr?.toLowerCase() === addr ||
              existingRoom.p2addr?.toLowerCase() === addr) {
            console.warn(`[join] ${addr.slice(0,8)}… already in room ${existingId} — rejecting join to ${gameId}`);
            _send(ws, { type: "error", code: "ALREADY_IN_GAME", existingGameId: existingId });
            ws.close();
            return;
          }
        }
      }

      if (msg.playerNum === 0) {
        const room = rooms.get(gameId);
        if (!room || !room.p1addr || !room.p2addr) {
          _send(ws, { type: 'error', code: 'GAME_NOT_FOUND' });
          ws.close();
          return;
        }
        if (!room.spectators) room.spectators = new Map();
        if (room.spectators.size >= 20) { ws.close(); return; }
        const specId = Date.now() + '_' + Math.random().toString(36).slice(2);
        ws._specId  = specId;
        ws._gameId  = gameId;
        ws._isSpec  = true;
        ws._alias   = msg.alias || '';
        room.spectators.set(specId, ws);
        _send(ws, {
          type:      'spectate_start',
          gameState: room.gameState || null,
          p1alias:   room.p1alias, p2alias: room.p2alias,
          p1addr:    room.p1addr,  p2addr:  room.p2addr,
          matchId:   room.matchId || null,
        });
        console.log(`[room ${gameId}] spectator joined — total: ${room.spectators.size}`);
        return;
      }

      ws._gameId    = gameId;
      ws._addr      = msg.addr || "";
      ws._alias     = msg.alias || "";

      if (!rooms.has(gameId)) rooms.set(gameId, { specMutedByP1: false, specMutedByP2: false });
      const room = rooms.get(gameId);

      // For tournament rooms, determine playerNum from pre-assigned addresses
      if (room && room.isTournament) {
        const addrLower = ws._addr.toLowerCase();
        if (room.p1addr && room.p1addr.toLowerCase() === addrLower) {
          ws._playerNum = 1;
        } else if (room.p2addr && room.p2addr.toLowerCase() === addrLower) {
          ws._playerNum = 2;
        } else {
          ws._playerNum = msg.playerNum;
        }
      } else {
        ws._playerNum = msg.playerNum;
      }

      room[`p${ws._playerNum}`]      = ws;
      room[`p${ws._playerNum}addr`]  = ws._addr;
      room[`p${ws._playerNum}alias`] = ws._alias;
      room[`p${ws._playerNum}seq`] = 0; // expected sequence from this player

      if (msg.betUSD)  room.betUSD  = String(msg.betUSD);
      if (msg.matchId) room.matchId = msg.matchId;
      if (msg.gameId)  room.matchId = room.matchId || String(msg.gameId);
      if (ws._alias) aliases.set(ws._addr.toLowerCase(), ws._alias);
      console.log(`[room ${gameId}] P${ws._playerNum} joined (${ws._addr.slice(0,8)}…)`);
      console.log(`[room ${gameId}] state after join: p1=${room.p1?'CONNECTED':'null'} p2=${room.p2?'CONNECTED':'null'}`);

      // If both players present, notify both
      if (room.p1 && room.p2) {
        console.log(`[room ${gameId}] Both players ready — sending ready`);
        pendingMatches.delete(room.p1addr?.toLowerCase());
        pendingMatches.delete(room.p2addr?.toLowerCase());
        const r1ok = _send(room.p1, { type: "ready", opponentAddr: room.p2addr, opponentAlias: room.p2alias, opponentNum: 2, yourPlayerNum: 1 });
        const r2ok = _send(room.p2, { type: "ready", opponentAddr: room.p1addr, opponentAlias: room.p1alias, opponentNum: 1, yourPlayerNum: 2 });
        console.log(`[room ${gameId}] ready sent to P1=${r1ok} P2=${r2ok}`);
      } else {
        console.log(`[room ${gameId}] waiting for ${room.p1 ? 'P2' : 'P1'}…`);
      }
    }

    // ── leave  (voluntary quit — triggers immediate gameover for opponent) ─
    else if (msg.type === "leave") {
      ws._leaving = true; // guard so close() handler doesn't double-fire
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const winnerNum = ws._playerNum === 1 ? 2 : 1;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      console.log(`[room ${ws._gameId}] P${ws._playerNum} sent leave — declaring P${winnerNum} winner immediately`);
      _send(other, { type: "gameover", winnerNum, reason: "opponent_left" });
      const _leaveWinAddr = winnerNum === 1 ? room.p1addr : room.p2addr;
      const _leaveLoserAddr = winnerNum === 1 ? room.p2addr : room.p1addr;
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (_leaveWinAddr && _leaveWinAddr !== ZERO)
        db.recordGameResult(_leaveWinAddr, true).catch(e => console.error(`[db] leave winner:`, e.message));
      if (_leaveLoserAddr && _leaveLoserAddr !== ZERO)
        db.recordGameResult(_leaveLoserAddr, false).catch(e => console.error(`[db] leave loser:`, e.message));
      pendingMatches.delete(room.p1addr?.toLowerCase());
      pendingMatches.delete(room.p2addr?.toLowerCase());
      if (_leaveWinAddr && _leaveWinAddr !== ZERO) {
        if (room.isTournament) {
          tournament.handleMatchResult(ws._gameId, _leaveWinAddr, _leaveLoserAddr);
        } else {
          room.winnerNum = winnerNum;
          _settle(ws._gameId, _leaveWinAddr, room);
        }
      }
      // close() will still fire; _leaving=true prevents double settle (via _settling Set)
    }

    // ── state / rack  (P1 → P2: ball layout sync) ────────────────────────
    else if (msg.type === "state" || msg.type === "rack") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, msg);
    }

    // ── shoot  (validate → simulate → compute game logic → broadcast) ────
    else if (msg.type === "shoot") {
      const room = rooms.get(ws._gameId);
      if (!room) return;

      const angle = msg.angle;
      const power = msg.power;
      const spinX = msg.spinX ?? 0;
      const spinY = msg.spinY ?? 0;

      // ── Validate shot parameters ─────────────────────────────────────────
      if (!validateShotParams(angle, power, spinX, spinY)) {
        console.warn(`[INVALID] shoot P${ws._playerNum} — angle=${angle} power=${power} spinX=${spinX} spinY=${spinY}`);
        return;
      }

      // ── Build pre-shot ball snapshot ─────────────────────────────────────
      const isBreakShot = !room.gameState?.balls;
      let preShotBalls;
      if (room.gameState?.balls) {
        preShotBalls = sanitizeSnapshot(JSON.parse(JSON.stringify(room.gameState.balls)));
      } else {
        preShotBalls = makeInitialBalls();
      }

      // Apply client's cue-ball position (handles ball-in-hand placement)
      if (msg.cueBallX != null && msg.cueBallY != null) {
        const cue = preShotBalls.find(b => b.id === 0);
        if (cue && !cue.out) { cue.x = msg.cueBallX; cue.y = msg.cueBallY; }
      }

      // ── Run server-side simulation ────────────────────────────────────────
      const t0 = Date.now();
      let simResult;
      try {
        simResult = simulateShot(preShotBalls, angle, power, spinX, spinY);
      } catch (err) {
        console.error(`[SIM] simulateShot threw for P${ws._playerNum}:`, err.message);
        // Simulation failed — relay shoot only; client stays in control this shot
        const other = ws._playerNum === 1 ? room.p2 : room.p1;
        _send(other, { type: 'shoot' });
        _sendSpectators(ws._gameId, { type: 'shoot' });
        return;
      }
      const simMs = Date.now() - t0;

      const preShotMap = {};
      for (const b of preShotBalls) preShotMap[b.id] = b;
      const newlyOut = simResult.balls.filter(b => b.out && !preShotMap[b.id]?.out);
      const ids = newlyOut.map(b => b.id).join(',') || 'none';
      console.log(`[SIM] P${ws._playerNum} ${simMs}ms — steps=${simResult.steps} pocketed=[${ids}] timedOut=${simResult.timedOut}`);

      // ── Compute authoritative game-logic state ────────────────────────────
      const logic = computeGameLogic(room.gameState, preShotBalls, simResult, isBreakShot);

      // ── Build result message ──────────────────────────────────────────────
      const resultMsg = {
        type:          'result',
        gameId:        ws._gameId,
        balls:         simResult.balls,
        frames:        simResult.frames,
        cur:           logic.cur,
        typed:         logic.typed,
        p1T:           logic.p1T,
        p2T:           logic.p2T,
        p1t:           logic.p1t,
        p2t:           logic.p2t,
        bonusShots:    logic.bonusShots,
        ballInHand:    logic.ballInHand,
        p1EightPocket: logic.p1EightPocket,
        p2EightPocket: logic.p2EightPocket,
      };

      room.lastShotInput = { angle, power, spinX, spinY, timestamp: Date.now(), playerNum: ws._playerNum };
      room.gameState = resultMsg;

      // Send shoot notification to opponent first so their animation can start
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, { type: 'shoot' });
      _sendSpectators(ws._gameId, { type: 'shoot' });

      // Broadcast authoritative result to both players:
      // — shooter receives echo for position reconciliation
      // — opponent receives it to apply game logic + start replay
      _send(ws, resultMsg);
      _send(other, resultMsg);
      _sendSpectators(ws._gameId, resultMsg);
    }

    // ── frame  (no-op — server simulation replaces live frame streaming) ──
    else if (msg.type === "frame") {
      // Server is authoritative; trajectory is sent via frames array in result.
    }

    // ── result  (server is authoritative — client result messages ignored) ──
    else if (msg.type === "result") {
      console.warn(`[IGNORED] P${ws._playerNum} sent result — server is authoritative. gameId=${ws._gameId}`);
    }

    // ── sync_state  (active player's live state, sent in response to request_state) ──
    else if (msg.type === "sync_state") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      clearTimeout(room.pendingRejoinTimeout);
      room.pendingRejoinTimeout = null;
      room.gameState = msg; // update snapshot with fresh data
      if (room.pendingRejoinWs) {
        _send(room.pendingRejoinWs, {
          type:      "rejoin_state",
          gameState: msg,
          p1alias:   room.p1alias || null,
          p2alias:   room.p2alias || null,
          p1addr:    room.p1addr  || null,
          p2addr:    room.p2addr  || null
        });
        room.pendingRejoinWs = null;
      }
    }

    // ── cueUpdate  (active player streams aim angle to opponent) ─────────
    else if (msg.type === "cueUpdate") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      const cueMsg = { type: "cueUpdate", angle: msg.angle, x: msg.x, y: msg.y, ballInHand: msg.ballInHand };
      _send(other, cueMsg);
      _sendSpectators(ws._gameId, cueMsg);
    }

    else if (msg.type === "chat") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const text = String(msg.text || '').trim().slice(0, 200);
      if (!text) return;

      if (ws._isSpec) {
        // Spectator sender — relay to players (respecting their mute) and other spectators
        const alias = '[Spec] ' + (ws._alias || 'Spectator');
        const chatMsg = { type: 'chat', from: alias, text, isSpec: true };
        if (!room.specMutedByP1) _send(room.p1, chatMsg);
        if (!room.specMutedByP2) _send(room.p2, chatMsg);
        if (room.spectators) {
          for (const [sid, spec] of room.spectators) {
            if (spec !== ws) _send(spec, chatMsg);
          }
        }
      } else {
        // Player sender — relay to opponent and all spectators
        const alias = ws._alias || (ws._playerNum === 1 ? room.p1alias : room.p2alias) || `P${ws._playerNum}`;
        const other = ws._playerNum === 1 ? room.p2 : room.p1;
        const chatMsg = { type: 'chat', from: alias, text, isSpec: false };
        _send(other, chatMsg);
        _sendSpectators(ws._gameId, chatMsg);
      }
    }

    else if (msg.type === "block_spectators") {
      const room = rooms.get(ws._gameId);
      if (!room || ws._isSpec) return;
      if (ws._playerNum === 1) room.specMutedByP1 = !room.specMutedByP1;
      if (ws._playerNum === 2) room.specMutedByP2 = !room.specMutedByP2;
      const muted = ws._playerNum === 1 ? room.specMutedByP1 : room.specMutedByP2;
      _send(ws, { type: 'spec_mute_state', muted });
    }

    // ── sound  (shooter relays collision/rail/pocket sounds to opponent) ──
    else if (msg.type === "sound") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      if (!["collision", "rail", "pocket"].includes(msg.sound)) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      const soundMsg = { type: "sound", sound: msg.sound, param: msg.param };
      _send(other, soundMsg);
      _sendSpectators(ws._gameId, soundMsg);
    }

    // ── timerTick  (active player broadcasts remaining seconds each tick) ──
    else if (msg.type === "timerTick") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, { type: "timerTick", sec: msg.sec });
    }

    // ── timeout  (active player's turn timer expired) ─────────────────────
    else if (msg.type === "timeout") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, { type: "timeout" });
    }

    // ── gameover (game ended — relay + on-chain settlement) ───────────────
    else if (msg.type === "gameover") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      if (_settling.has(String(ws._gameId))) return; // already settling

      const reportingPlayer = ws._playerNum; // 1 or 2
      const claimedWinnerNum = msg.winnerNum;

      // Validate winnerNum is 1 or 2
      if (claimedWinnerNum !== 1 && claimedWinnerNum !== 2) {
        console.warn(`[gameover] invalid winnerNum ${claimedWinnerNum} from P${reportingPlayer} in ${ws._gameId}`);
        return;
      }

      // Initialize consensus tracking on room
      if (!room.gameoverVotes) room.gameoverVotes = {};
      room.gameoverVotes[reportingPlayer] = claimedWinnerNum;

      console.log(`[gameover] P${reportingPlayer} reports winner=P${claimedWinnerNum} in game ${ws._gameId}`);

      const votes = room.gameoverVotes;
      const bothVoted = votes[1] !== undefined && votes[2] !== undefined;

      if (!bothVoted) {
        // First vote — relay gameover to opponent so they report too
        const other = reportingPlayer === 1 ? room.p2 : room.p1;
        _send(other, msg);
        _sendSpectators(ws._gameId, msg);

        // Start 10s timeout: if second player doesn't report, trust the first
        room._gameoverTimeout = setTimeout(() => {
          const r = rooms.get(ws._gameId);
          if (!r || _settling.has(String(ws._gameId))) return;
          if (r.gameoverVotes && Object.keys(r.gameoverVotes).length === 1) {
            console.warn(`[gameover] timeout — only P${reportingPlayer} voted in ${ws._gameId}, settling with their report`);
            const serverWinner = serverDetermineWinner(r.gameState, claimedWinnerNum, msg.reason);
            if (serverWinner === null) {
              console.warn(`[gameover] server could not validate gameState — gameId: ${ws._gameId}, claimedWinner: ${claimedWinnerNum}`);
              console.warn(`[gameover] gameState snapshot:`, JSON.stringify(r.gameState?.balls?.map(b => ({ id: b.id, out: b.out }))));
              return;
            }
            if (serverWinner !== claimedWinnerNum) {
              console.warn(`[CHEAT DETECTED] gameId: ${ws._gameId} | P${reportingPlayer} claimed winner: ${claimedWinnerNum} | server says: ${serverWinner}`);
            }
            serverValidateLastShot(r);
            _resolveGameover(ws._gameId, r, serverWinner, msg);
          }
        }, 10000);
        return;
      }

      // Both voted — clear timeout
      if (room._gameoverTimeout) {
        clearTimeout(room._gameoverTimeout);
        room._gameoverTimeout = null;
      }

      if (votes[1] === votes[2]) {
        // Consensus reached
        console.log(`[gameover] consensus: both players agree winner=P${votes[1]} in game ${ws._gameId}`);
        const serverWinner = serverDetermineWinner(room.gameState, votes[1], msg.reason);
        if (serverWinner === null) {
          console.warn(`[gameover] server could not validate gameState — gameId: ${ws._gameId}, claimedWinner: ${votes[1]}`);
          console.warn(`[gameover] gameState snapshot:`, JSON.stringify(room.gameState?.balls?.map(b => ({ id: b.id, out: b.out }))));
          return;
        }
        if (serverWinner !== votes[1]) {
          console.warn(`[CHEAT DETECTED] gameId: ${ws._gameId} | P${reportingPlayer} claimed winner: ${votes[1]} | server says: ${serverWinner}`);
        }
        serverValidateLastShot(room);
        _resolveGameover(ws._gameId, room, serverWinner, msg);
      } else {
        // Dispute — log and settle with second reporter's claim after short delay
        console.warn(`[gameover] DISPUTE in game ${ws._gameId}: P1 says P${votes[1]} won, P2 says P${votes[2]} won`);
        // In a dispute, we trust the loser's report (the winner wouldn't lie about losing)
        // P1 says P${votes[1]} won — if votes[1]===2, P1 is reporting they lost (trustworthy)
        // P2 says P${votes[2]} won — if votes[2]===1, P2 is reporting they lost (trustworthy)
        let trustedWinnerNum = null;
        if (votes[1] === 2) trustedWinnerNum = 2; // P1 says P2 won — trust P1 reporting their own loss
        else if (votes[2] === 1) trustedWinnerNum = 1; // P2 says P1 won — trust P2 reporting their own loss
        else {
          // Both claiming they won — neither trustworthy
          // Default: trust the player who reported second (they had more time to observe)
          trustedWinnerNum = reportingPlayer === 1 ? votes[1] : votes[2];
          console.warn(`[gameover] both claiming victory — defaulting to second reporter P${reportingPlayer}'s claim`);
        }
        console.log(`[gameover] dispute resolved: winner=P${trustedWinnerNum} in game ${ws._gameId}`);
        const serverWinner = serverDetermineWinner(room.gameState, trustedWinnerNum, msg.reason);
        if (serverWinner === null) {
          console.warn(`[gameover] server could not validate gameState — gameId: ${ws._gameId}, claimedWinner: ${trustedWinnerNum}`);
          console.warn(`[gameover] gameState snapshot:`, JSON.stringify(room.gameState?.balls?.map(b => ({ id: b.id, out: b.out }))));
          return;
        }
        if (serverWinner !== trustedWinnerNum) {
          console.warn(`[CHEAT DETECTED] gameId: ${ws._gameId} | P${reportingPlayer} claimed winner: ${trustedWinnerNum} | server says: ${serverWinner}`);
        }
        serverValidateLastShot(room);
        _resolveGameover(ws._gameId, room, serverWinner, msg);
      }
    }

  });

  ws.on("close", () => {
    if (ws._isSpec && ws._gameId) {
      const room = rooms.get(ws._gameId);
      if (room?.spectators) {
        room.spectators.delete(ws._specId);
        console.log(`[room ${ws._gameId}] spectator left — remaining: ${room.spectators.size}`);
      }
      return;
    }
    // Remove from matchmaking queue if present — only if this ws is still the current entry
    for (const q of Object.values(mmQueues)) {
      const entry = q.get(ws._addr);
      if (entry && entry.ws === ws) q.delete(ws._addr);
    }
    if (!ws._gameId) return;
    const room = rooms.get(ws._gameId);
    if (!room) return;

    const pNum  = ws._playerNum;
    const other = pNum === 1 ? room.p2 : room.p1;
    const winnerNum = pNum === 1 ? 2 : 1;

    // ── CASE A: voluntary leave ────────────────────────────────────────────
    if (ws._leaving) {
      console.log(`[room ${ws._gameId}] P${pNum} left voluntarily`);
      // gameover + settle already fired in 'leave' handler; _settling Set prevents double-settle
      const _caWinAddr = winnerNum === 1 ? room.p1addr : room.p2addr;
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (_caWinAddr && _caWinAddr !== ZERO) _settle(ws._gameId, _caWinAddr, room);
      room[`p${pNum}`] = null;
      if (!room.p1 && !room.p2) rooms.delete(ws._gameId);
      return;
    }

    // ── CASE B: involuntary disconnect — start 60s reconnect window ────────
    if (_settling.has(String(ws._gameId))) return; // settle already in-flight, no countdown needed
    console.log(`[room ${ws._gameId}] P${pNum} disconnected — starting 60s window`);
    room[`p${pNum}`] = null; // clear stale socket; addr is preserved for reconnect check

    const TIMEOUT_SEC = 60;
    let timeLeft = TIMEOUT_SEC;

    _send(other, { type: "opponent_disconnected", timeLeft });

    // Send countdown every second
    const cdKey   = `p${pNum}cd`;
    const timerKey = `p${pNum}timer`;

    room[cdKey] = setInterval(() => {
      timeLeft--;
      _send(other, { type: "reconnect_countdown", timeLeft });
    }, 1000);

    room[timerKey] = setTimeout(() => {
      clearInterval(room[cdKey]); room[cdKey] = null; room[timerKey] = null;
      console.log(`[room ${ws._gameId}] P${pNum} timed out — declaring P${winnerNum} winner`);
      _send(other, { type: "gameover", winnerNum, reason: "opponent_timeout" });
      _resolveGameover(ws._gameId, room, winnerNum, {});
      rooms.delete(ws._gameId);
    }, TIMEOUT_SEC * 1000);
  });

  ws.on("error", (err) => {
    console.error(`[WS error P${ws._playerNum}]`, err.message);
  });
});

function _send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  if (!ws) return false; // null socket — silent return, no log
  console.warn(`[_send] FAILED — ws readyState:${ws.readyState} msg=${obj.type}`);
  return false;
}

function _sendSpectators(gameId, msg) {
  const room = rooms.get(gameId);
  if (!room?.spectators) return;
  for (const ws of room.spectators.values()) {
    _send(ws, msg);
  }
}

db.init().catch(e => console.error("[db] init failed:", e.message, e.stack));

httpServer.listen(PORT, () => {
  console.log(`PengPool sync server  →  ws://localhost:${PORT}`);
  _resolveOrphanedMatches()
    .catch(err => console.error("[OrphanResolver] Unhandled error:", err.message))
    .finally(() => {
      _serverReady = true;
      console.log("[OrphanResolver] Server ready — accepting WebSocket connections");
    });
});
