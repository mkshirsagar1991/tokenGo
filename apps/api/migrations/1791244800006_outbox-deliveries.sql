-- Up Migration
-- Outbox hardening (docs §L.1 #6): events are CLAIMED with a visibility timeout (a crashed worker's claim
-- simply expires) and each (event, consumer) delivery is recorded exactly once, so a retry after a partial
-- failure re-runs only the consumers that did not finish.

ALTER TABLE platform.outbox_events ADD COLUMN locked_until timestamptz;
ALTER TABLE platform.outbox_events DROP CONSTRAINT outbox_events_status_check;
ALTER TABLE platform.outbox_events ADD CONSTRAINT outbox_events_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED'));

DROP INDEX platform.outbox_events_pending_idx;
-- Claimable = PENDING and due, or PROCESSING whose claim expired.
CREATE INDEX outbox_events_claimable_idx ON platform.outbox_events (available_at)
  WHERE status IN ('PENDING', 'PROCESSING');
CREATE INDEX outbox_events_done_idx ON platform.outbox_events (processed_at) WHERE status = 'DONE';

CREATE TABLE platform.outbox_deliveries (
  event_id     uuid        NOT NULL REFERENCES platform.outbox_events (id) ON DELETE CASCADE,
  consumer     text        NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);

-- Down Migration
