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

const http      = require("http");
const WebSocket = require("ws");
const { ethers } = require("ethers");

const PORT = process.env.PORT || 8080;

// ── On-chain settlement ───────────────────────────────────────────────────────

const PENGPOOL_ADDRESS = "0xEeA18855Ffd6824dB84e17e27E616771dFAbfC1F";
const DECLARE_ABI = [
  "function declareWinner(uint256 gameId, address winner) external",
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

// gameIds already settled or in-progress — avoid double-settling
const _settling = new Set();

async function _settle(gameId, winnerAddress, room) {
  const key = String(gameId);
  if (_settling.has(key)) { console.log(`[settle] game ${gameId} already settling, skipping`); return; }
  _settling.add(key);

  const contract = _getContract();
  if (!contract) {
    _broadcastRoom(room, { type: "settled", error: "Server wallet not configured" });
    return;
  }

  console.log(`[settle] Declaring winner for game ${gameId} → ${winnerAddress}`);
  try {
    const tx = await contract.declareWinner(BigInt(gameId), winnerAddress);
    console.log(`[settle] tx sent: ${tx.hash}`);
    _broadcastRoom(room, { type: "settled", txHash: tx.hash, gameId });
    await tx.wait();
    console.log(`[settle] game ${gameId} confirmed`);
  } catch (err) {
    const msg = err.shortMessage || err.message || String(err);
    console.error(`[settle] game ${gameId} failed:`, msg);
    _broadcastRoom(room, { type: "settled", error: msg, gameId });
    _settling.delete(key); // allow retry if transient error
  }
}

function _broadcastRoom(room, obj) {
  _send(room.p1, obj);
  _send(room.p2, obj);
}

// rooms: Map<gameId:string, { p1, p2, p1addr, p2addr, p1alias, p2alias }>
const rooms = new Map();

// Global alias registry: addr.toLowerCase() → alias
const aliases = new Map();

const CORS = { "Access-Control-Allow-Origin": "*" };

const httpServer = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type" });
    res.end(); return;
  }
  if (req.method === "GET" && req.url === "/aliases") {
    res.writeHead(200, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify(Object.fromEntries(aliases))); return;
  }
  if (req.method === "POST" && req.url === "/alias") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const { addr, alias } = JSON.parse(body);
        if (addr && alias) aliases.set(addr.toLowerCase(), String(alias).slice(0, 20));
      } catch {}
      res.writeHead(200, { "Content-Type": "text/plain", ...CORS });
      res.end("OK");
    }); return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PengPool sync OK\n");
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws) => {
  ws._gameId    = null;
  ws._playerNum = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── join ──────────────────────────────────────────────────────────────
    if (msg.type === "join") {
      const gameId = String(msg.gameId);
      ws._gameId    = gameId;
      ws._playerNum = msg.playerNum; // 1 or 2
      ws._addr      = msg.addr || "";
      ws._alias     = msg.alias || "";

      if (!rooms.has(gameId)) rooms.set(gameId, {});
      const room = rooms.get(gameId);

      room[`p${msg.playerNum}`]      = ws;
      room[`p${msg.playerNum}addr`]  = ws._addr;
      room[`p${msg.playerNum}alias`] = ws._alias;

      if (ws._alias) aliases.set(ws._addr.toLowerCase(), ws._alias);
      console.log(`[room ${gameId}] P${msg.playerNum} joined (${ws._addr.slice(0,8)}…)`);
      console.log('Player joined, alias:', ws._alias, 'addr:', ws._addr);
      console.log(`[room ${gameId}] state after join: p1=${room.p1?'CONNECTED':'null'} p2=${room.p2?'CONNECTED':'null'}`);
      console.log(`[room ${gameId}] raw gameId type=${typeof msg.gameId} value=${JSON.stringify(msg.gameId)}`);
      console.log(`[room ${gameId}] all rooms: [${[...rooms.keys()].join(', ')}]`);

      // If both players present, notify both
      if (room.p1 && room.p2) {
        console.log(`[room ${gameId}] Both players ready — sending ready`);
        console.log('Sending ready, opponentAlias for P1:', room.p2alias, '| for P2:', room.p1alias);
        const r1ok = _send(room.p1, { type: "ready", opponentAddr: room.p2addr, opponentAlias: room.p2alias, opponentNum: 2 });
        const r2ok = _send(room.p2, { type: "ready", opponentAddr: room.p1addr, opponentAlias: room.p1alias, opponentNum: 1 });
        console.log(`[room ${gameId}] ready sent to P1=${r1ok} P2=${r2ok}`);
      } else {
        console.log(`[room ${gameId}] waiting for ${room.p1 ? 'P2' : 'P1'}…`);
      }
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
    }

    // ── frame  (live ball positions while balls are moving) ───────────────
    else if (msg.type === "frame") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, msg);
    }

    // ── result  (authoritative final ball state after a shot) ─────────────
    else if (msg.type === "result") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, msg);
    }

    // ── cueUpdate  (active player streams aim angle to opponent) ─────────
    else if (msg.type === "cueUpdate") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, { type: "cueUpdate", angle: msg.angle, x: msg.x, y: msg.y });
    }

    // ── sound  (shooter relays collision/rail/pocket sounds to opponent) ──
    else if (msg.type === "sound") {
      const room = rooms.get(ws._gameId);
      if (!room) return;
      const other = ws._playerNum === 1 ? room.p2 : room.p1;
      _send(other, { type: "sound", sound: msg.sound, param: msg.param });
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
      // Determine winner address from the stored room addresses
      const winnerAddr = msg.winnerNum === 1 ? room.p1addr : room.p2addr;
      if (!winnerAddr || winnerAddr === "0x0000000000000000000000000000000000000000") {
        console.warn(`[settle] game ${ws._gameId}: no address for winner P${msg.winnerNum}`);
        return;
      }
      _settle(ws._gameId, winnerAddr, room);
    }

  });

  ws.on("close", () => {
    if (!ws._gameId) return;
    const room = rooms.get(ws._gameId);
    if (!room) return;

    // Notify opponent
    const other = ws._playerNum === 1 ? room.p2 : room.p1;
    _send(other, { type: "disconnect" });

    // Remove this player from room
    room[`p${ws._playerNum}`] = null;

    // Clean up empty rooms
    if (!room.p1 && !room.p2) {
      rooms.delete(ws._gameId);
      console.log(`[room ${ws._gameId}] closed`);
    }
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
  console.warn(`[_send] FAILED — ws=${ws?`readyState:${ws.readyState}`:'null'} msg=${obj.type}`);
  return false;
}

httpServer.listen(PORT, () => {
  console.log(`PengPool sync server  →  ws://localhost:${PORT}`);
});
