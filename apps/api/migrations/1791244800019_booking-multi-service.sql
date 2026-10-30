-- Up Migration
-- One booking can now hold SEVERAL services (a haircut + a facial; a car wash + tyre change). `booking.booking_items` already holds
-- one immutable priced line per service; only the ORDER the customer chose them in was not recorded.
ALTER TABLE booking.booking_items ADD COLUMN position smallint NOT NULL DEFAULT 0 CHECK (position >= 0);

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
