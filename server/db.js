"use strict";

const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Level formula ─────────────────────────────────────────────────────────────
// Level N requires Math.floor(50 * N^1.8) cumulative points. Max level: 50.

function _pointsForLevel(n) {
  return Math.floor(50 * Math.pow(n, 1.8));
}

function _levelForPoints(pts) {
  let level = 0;
  for (let n = 1; n <= 50; n++) {
    if (pts >= _pointsForLevel(n)) level = n;
    else break;
  }
  return level;
}

function _buildProfile(row) {
  const level     = _levelForPoints(row.points);
  const levelStart = level > 0 ? _pointsForLevel(level) : 0;
  const levelEnd   = level < 50 ? _pointsForLevel(level + 1) : levelStart + 1;
  const ptsInLevel = row.points - levelStart;
  const ptsSpan    = levelEnd - levelStart;
  return {
    wallet:            row.wallet,
    username:          row.username,
    points:            row.points,
    games_played:      row.games_played,
    games_won:         row.games_won,
    created_at:        row.created_at,
    level,
    points_to_next_level: level < 50 ? levelEnd - row.points : 0,
    level_progress_pct:   level < 50 ? Math.round(ptsInLevel / ptsSpan * 100) : 100,
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      wallet       TEXT PRIMARY KEY,
      username     TEXT,
      points       INTEGER NOT NULL DEFAULT 0,
      games_played INTEGER NOT NULL DEFAULT 0,
      games_won    INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Add UNIQUE constraint even if the table already existed without it.
  // PostgreSQL allows duplicate NULLs in UNIQUE columns — wallets without
  // a username won't conflict with each other.
  try {
    await pool.query(`ALTER TABLE players ADD CONSTRAINT players_username_unique UNIQUE (username)`);
  } catch (e) {
    if (!e.message.includes('already exists')) throw e;
  }
  console.log("[db] players table ready");
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function getPlayer(wallet) {
  const { rows } = await pool.query(
    "SELECT * FROM players WHERE wallet = $1",
    [wallet.toLowerCase()]
  );
  return rows.length ? _buildProfile(rows[0]) : null;
}

async function registerPlayer(wallet, username) {
  const w = wallet.toLowerCase();
  const u = username.trim().slice(0, 20);
  if (!u) throw new Error("Username cannot be empty");

  // Case-insensitive duplicate check (exclude this wallet's own row)
  const dup = await pool.query(
    "SELECT wallet FROM players WHERE LOWER(username) = LOWER($1)",
    [u]
  );
  if (dup.rows.length && dup.rows[0].wallet !== w) {
    throw new Error("Username already taken");
  }

  await pool.query(
    `INSERT INTO players (wallet, username)
     VALUES ($1, $2)
     ON CONFLICT (wallet) DO UPDATE SET username = EXCLUDED.username`,
    [w, u]
  );
  return getPlayer(w);
}

async function renamePlayer(wallet, username) {
  const w = wallet.toLowerCase();
  const u = username.trim().slice(0, 20);
  if (!u) throw new Error("Username cannot be empty");

  const dup = await pool.query(
    "SELECT wallet FROM players WHERE LOWER(username) = LOWER($1)",
    [u]
  );
  if (dup.rows.length && dup.rows[0].wallet !== w) {
    throw new Error("Username already taken");
  }

  const result = await pool.query(
    "UPDATE players SET username = $1 WHERE wallet = $2",
    [u, w]
  );
  if (result.rowCount === 0) throw new Error("Player not found — play a PvP game first");
  return getPlayer(w);
}

// Called automatically at the end of every PvP match (never practice/bot).
// Creates the player row if it doesn't exist yet (wallet may not have registered).
async function recordGameResult(wallet, won) {
  const w   = wallet.toLowerCase();
  const pts = won ? 50 : 20;
  await pool.query(
    `INSERT INTO players (wallet, points, games_played, games_won)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (wallet) DO UPDATE SET
       points       = players.points + $2,
       games_played = players.games_played + 1,
       games_won    = players.games_won + $3`,
    [w, pts, won ? 1 : 0]
  );
}

// Returns top 100 players sorted by wins desc, win_rate desc.
// If `wallet` is provided and not in top 100, also returns their rank + data as `caller`.
async function getLeaderboard(wallet) {
  const TOP_SQL = `
    SELECT
      ROW_NUMBER() OVER (
        ORDER BY games_won DESC,
                 CASE WHEN games_played = 0 THEN 0
                      ELSE ROUND(games_won * 100.0 / games_played, 1)
                 END DESC
      )::int AS rank,
      wallet,
      username,
      games_won,
      games_played,
      CASE WHEN games_played = 0 THEN 0
           ELSE ROUND(games_won * 100.0 / games_played, 1)
      END AS win_rate,
      points
    FROM players
    ORDER BY games_won DESC,
             CASE WHEN games_played = 0 THEN 0
                  ELSE ROUND(games_won * 100.0 / games_played, 1)
             END DESC
    LIMIT 100
  `;
  const { rows } = await pool.query(TOP_SQL);
  const top = rows.map(r => ({
    rank:         Number(r.rank),
    wallet:       r.wallet,
    username:     r.username || null,
    games_won:    r.games_won,
    games_played: r.games_played,
    win_rate:     Number(r.win_rate),
    points:       r.points,
    level:        _levelForPoints(r.points),
  }));

  // If caller wallet provided and not already in top 100, fetch their own rank
  let caller = null;
  if (wallet) {
    const w = wallet.toLowerCase();
    const inTop = top.find(r => r.wallet === w);
    if (!inTop) {
      const RANK_SQL = `
        SELECT sub.rank, p.username, p.games_won, p.games_played,
               CASE WHEN p.games_played = 0 THEN 0
                    ELSE ROUND(p.games_won * 100.0 / p.games_played, 1)
               END AS win_rate,
               p.points
        FROM players p
        JOIN (
          SELECT wallet,
                 ROW_NUMBER() OVER (
                   ORDER BY games_won DESC,
                            CASE WHEN games_played = 0 THEN 0
                                 ELSE ROUND(games_won * 100.0 / games_played, 1)
                            END DESC
                 )::int AS rank
          FROM players
        ) sub ON sub.wallet = p.wallet
        WHERE p.wallet = $1
      `;
      const { rows: cr } = await pool.query(RANK_SQL, [w]);
      if (cr.length) {
        const r = cr[0];
        caller = {
          rank:         Number(r.rank),
          wallet:       w,
          username:     r.username || null,
          games_won:    r.games_won,
          games_played: r.games_played,
          win_rate:     Number(r.win_rate),
          points:       r.points,
          level:        _levelForPoints(r.points),
        };
      }
    }
  }

  return { top, caller };
}

module.exports = { pool, init, getPlayer, registerPlayer, renamePlayer, recordGameResult, getLeaderboard };
