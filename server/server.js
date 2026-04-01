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

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const tournament = require("./tournament");

const http      = require("http");
const WebSocket = require("ws");
const { ethers } = require("ethers");
const db        = require("./db");

const PORT = process.env.PORT || 8080;

// ── On-chain settlement ───────────────────────────────────────────────────────

const PENGPOOL_ADDRESS = "0x498ECbe4dc1a7e25bb9A3A4F58FEd890f2A3E455";
const DECLARE_ABI = [
  "function declareWinner(uint256 matchId, address winner) external",
  "function matchPlayers(address addr1, address addr2, uint8 betUSD) external returns (uint256 matchId)",
  "event MatchCreated(uint256 indexed matchId, address indexed player1, address indexed player2, uint256 betAmount, uint8 betUSD)",
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

    // ── existing alias endpoints ──────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/aliases") {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS });
      res.end(JSON.stringify(Object.fromEntries(aliases))); return;
    }
    if (req.method === "POST" && req.url === "/alias") {
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

const wss = new WebSocket.Server({ server: httpServer });

// Init tournament module
const _wp = _getWalletAndProvider();
if (_wp) {
  tournament.initTournament(wss, db.pool, _wp.wallet, _wp.provider, rooms);
}

wss.on("connection", (ws) => {
  ws._gameId    = null;
  ws._playerNum = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Matchmaking: join queue ────────────────────────────────────────────
    if (msg.type === 'mm_join_queue') {
      // Identify the WS connection if not already done
      if (!ws._addr && msg.addr) {
        ws._addr  = msg.addr.toLowerCase();
        ws._alias = msg.alias || ws._addr;
        aliases.set(ws._addr, ws._alias);
      }
      if (!ws._addr) { _send(ws, { type: 'mm_error', reason: 'not_identified' }); return; }
      const betKey = String(msg.betUSD) === '5' ? '5' : '1';
      const queue  = mmQueues[betKey];
      // Remove from other queue if present
      for (const [bk, q] of Object.entries(mmQueues)) {
        if (bk !== betKey) q.delete(ws._addr);
      }
      queue.set(ws._addr, {
        ws, addr: ws._addr, alias: ws._alias || ws._addr,
        level: Number(msg.level) || 1,
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
      const gameId = String(msg.gameId);
      console.log(`[mm] P1 created game ${gameId} — notifying P2`);
      _send(p2.ws, { type: 'mm_join_game', gameId, opponentAlias: ws._alias, opponentAddr: ws._addr });
      return;
    }

    // ── join ──────────────────────────────────────────────────────────────
    if (msg.type === "join") {
      const gameId = String(msg.gameId);
      const addr   = (msg.addr || "").toLowerCase();

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
        const specId = Date.now() + '_' + Math.random().toString(36).slice(2);
        ws._specId  = specId;
        ws._gameId  = gameId;
        ws._isSpec  = true;
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

      if (!rooms.has(gameId)) rooms.set(gameId, {});
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

    // ── shoot  (relay shot to opponent) ───────────────────────────────────
    else if (msg.type === "shoot") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, { type: "shoot" });
      _sendSpectators(ws._gameId, { type: "shoot" });
    }

    // ── frame  (live ball positions while balls are moving) ───────────────
    else if (msg.type === "frame") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, msg);
      _sendSpectators(ws._gameId, msg);
    }

    // ── result  (authoritative final ball state after a shot) ─────────────
    else if (msg.type === "result") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, msg);
      // Snapshot latest game state so a reconnecting player can resume
      room.gameState = msg;
      _sendSpectators(ws._gameId, msg);
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

    // ── sound  (shooter relays collision/rail/pocket sounds to opponent) ──
    else if (msg.type === "sound") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
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
      // Relay to opponent so their screen shows the winner
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, msg);
      _sendSpectators(ws._gameId, msg);
      // Determine winner/loser addresses from the stored room
      const winnerAddr = msg.winnerNum === 1 ? room.p1addr : room.p2addr;
      const loserAddr  = msg.winnerNum === 1 ? room.p2addr : room.p1addr;

      // Record PvP result in DB for both players (fire-and-forget)
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (winnerAddr && winnerAddr !== ZERO) {
        db.recordGameResult(winnerAddr, true).catch(e =>
          console.error(`[db] game-result winner P${msg.winnerNum}:`, e.message));
      }
      if (loserAddr && loserAddr !== ZERO) {
        db.recordGameResult(loserAddr, false).catch(e =>
          console.error(`[db] game-result loser:`, e.message));
      }

      if (!winnerAddr || winnerAddr === ZERO) {
        console.warn(`[settle] game ${ws._gameId}: no address for winner P${msg.winnerNum}`);
        return;
      }

      // Tournament rooms: route to tournament handler, skip PvP settlement
      if (room.isTournament) {
        tournament.handleMatchResult(ws._gameId, winnerAddr, loserAddr);
        return;
      }

      room.winnerNum = msg.winnerNum;
      _settle(ws._gameId, winnerAddr, room);
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
    // Remove from matchmaking queue if present
    for (const q of Object.values(mmQueues)) q.delete(ws._addr);
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
      const _toWinAddr  = winnerNum === 1 ? room.p1addr : room.p2addr;
      const _toLoseAddr = winnerNum === 1 ? room.p2addr : room.p1addr;
      const ZERO = "0x0000000000000000000000000000000000000000";
      if (_toWinAddr && _toWinAddr !== ZERO)
        db.recordGameResult(_toWinAddr, true).catch(e => console.error(`[db] timeout winner:`, e.message));
      if (_toLoseAddr && _toLoseAddr !== ZERO)
        db.recordGameResult(_toLoseAddr, false).catch(e => console.error(`[db] timeout loser:`, e.message));
      if (_toWinAddr && _toWinAddr !== ZERO) {
        if (room.isTournament) {
          tournament.handleMatchResult(ws._gameId, _toWinAddr, _toLoseAddr);
          rooms.delete(ws._gameId);
          return;
        }
        room.winnerNum = winnerNum; _settle(ws._gameId, _toWinAddr, room);
      }
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
});
