-- Up Migration
-- Account deletion (requirements §5 / §25): a deletion request deactivates the account at once and schedules anonymisation after
-- a grace period; signing in again within it cancels the request. These columns carry that state.

ALTER TABLE identity.users
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_due_at       timestamptz,
  ADD COLUMN deletion_blocked_reason text,
  ADD CONSTRAINT users_deletion_chk CHECK ((deletion_requested_at IS NULL) = (deletion_due_at IS NULL));

CREATE INDEX users_deletion_due_idx ON identity.users (deletion_due_at) WHERE deletion_due_at IS NOT NULL AND status = 'DEACTIVATED';

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
