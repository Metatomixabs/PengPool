-- Migration 001: Tournament system tables
-- Created for PengPool tournament feature

-- ─────────────────────────────────────────────────────────────────────────────
-- tournaments
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tournaments (
    id                SERIAL PRIMARY KEY,
    chain_id          INTEGER      NOT NULL UNIQUE,
    name              VARCHAR(100) NOT NULL,
    type              VARCHAR(10)  NOT NULL CHECK (type IN ('regular', 'custom')),
    creator_addr      VARCHAR(42)  NOT NULL,
    buy_in_usd        INTEGER      NOT NULL CHECK (buy_in_usd IN (1, 2, 5)),
    start_time        TIMESTAMPTZ  NOT NULL,
    status            VARCHAR(12)  NOT NULL DEFAULT 'registration'
                                   CHECK (status IN ('registration', 'active', 'finished', 'cancelled')),
    participant_count INTEGER      NOT NULL DEFAULT 0,
    prize_pool_eth    NUMERIC(36, 18) NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- tournament_participants
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tournament_participants (
    id              SERIAL PRIMARY KEY,
    tournament_id   INTEGER     NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    player_addr     VARCHAR(42) NOT NULL,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    final_position  INTEGER     DEFAULT NULL,
    prize_claimed   BOOLEAN     NOT NULL DEFAULT FALSE,
    UNIQUE (tournament_id, player_addr)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- tournament_matches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE tournament_matches (
    id              SERIAL PRIMARY KEY,
    tournament_id   INTEGER      NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    chain_match_id  INTEGER      NOT NULL,
    round           INTEGER      NOT NULL,
    match_number    INTEGER      NOT NULL,
    player1_addr    VARCHAR(42)  DEFAULT NULL,
    player2_addr    VARCHAR(42)  DEFAULT NULL,
    winner_addr     VARCHAR(42)  DEFAULT NULL,
    is_bye          BOOLEAN      NOT NULL DEFAULT FALSE,
    status          VARCHAR(10)  NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'active', 'finished')),
    room_id         VARCHAR(100) DEFAULT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (tournament_id, chain_match_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX idx_tournaments_status             ON tournaments(status);
CREATE INDEX idx_tournaments_start_time         ON tournaments(start_time);
CREATE INDEX idx_participants_tournament_id     ON tournament_participants(tournament_id);
CREATE INDEX idx_participants_player_addr       ON tournament_participants(player_addr);
CREATE INDEX idx_matches_tournament_id          ON tournament_matches(tournament_id);
CREATE INDEX idx_matches_tournament_round       ON tournament_matches(tournament_id, round);
