-- Migration 002: Add distribution_failed tournament status
-- Needed so a failed distributePrizes tx leaves the tournament in a recoverable
-- state instead of masking the failure by marking it 'finished'.

ALTER TABLE tournaments
  DROP CONSTRAINT tournaments_status_check,
  ADD CONSTRAINT tournaments_status_check
    CHECK (status IN ('registration', 'active', 'finished', 'cancelled', 'distribution_failed'));

-- Recreate partial unique index to treat distribution_failed as a terminal state
-- (same as finished/cancelled) so it never blocks a new tournament for the same chain_id.
DROP INDEX tournaments_chain_id_active_unique;
CREATE UNIQUE INDEX tournaments_chain_id_active_unique
    ON tournaments(chain_id)
    WHERE status NOT IN ('finished', 'cancelled', 'distribution_failed');
