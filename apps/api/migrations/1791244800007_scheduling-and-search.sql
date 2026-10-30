-- Up Migration
CREATE SCHEMA IF NOT EXISTS scheduling;
CREATE SCHEMA IF NOT EXISTS search;

-- ===== Weekly recurring hours / breaks, for a LOCATION or for a RESOURCE (stylist) =====================
-- Times are LOCAL wall-clock minutes (0..1440) in the location's IANA timezone; UTC conversion happens at
-- query time so DST is always right (docs §H.3). weekday: ISO 1=Mon .. 7=Sun.
CREATE TABLE scheduling.availability_rules (
  id          uuid PRIMARY KEY,
  location_id uuid REFERENCES provider.provider_locations (id),
  resource_id uuid REFERENCES provider.bookable_resources (id),
  rule_type   text        NOT NULL CHECK (rule_type IN ('WORKING', 'BREAK')),
  weekday     smallint    NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min   smallint    NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     smallint    NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_rules_range_chk CHECK (end_min > start_min),
  CONSTRAINT availability_rules_scope_chk CHECK ((location_id IS NULL) <> (resource_id IS NULL)),
  -- Two windows of the same kind on the same day for the same owner may not overlap.
  CONSTRAINT availability_rules_no_overlap EXCLUDE USING gist (
    (COALESCE(location_id, resource_id)) WITH =,
    weekday WITH =,
    rule_type WITH =,
    int4range(start_min, end_min) WITH &&
  )
);
CREATE INDEX availability_rules_location_idx ON scheduling.availability_rules (location_id) WHERE location_id IS NOT NULL;
CREATE INDEX availability_rules_resource_idx ON scheduling.availability_rules (resource_id) WHERE resource_id IS NOT NULL;
CREATE TRIGGER availability_rules_updated_at BEFORE UPDATE ON scheduling.availability_rules
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- ===== Dated overrides: holidays / leave (CLOSED) and special openings (OPEN) ===========================
CREATE TABLE scheduling.availability_exceptions (
  id          uuid PRIMARY KEY,
  location_id uuid REFERENCES provider.provider_locations (id),
  resource_id uuid REFERENCES provider.bookable_resources (id),
  kind        text        NOT NULL CHECK (kind IN ('CLOSED', 'OPEN')),
  start_date  date        NOT NULL,            -- local calendar dates, inclusive
  end_date    date        NOT NULL,
  start_min   smallint,                        -- NULL/NULL => the whole day
  end_min     smallint,
  reason      text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_dates_chk CHECK (end_date >= start_date),
  CONSTRAINT availability_exceptions_scope_chk CHECK ((location_id IS NULL) <> (resource_id IS NULL)),
  CONSTRAINT availability_exceptions_window_chk CHECK (
    (start_min IS NULL AND end_min IS NULL) OR (start_min BETWEEN 0 AND 1439 AND end_min BETWEEN 1 AND 1440 AND end_min > start_min)
  ),
  -- an OPEN override must say WHEN (a whole-day OPEN is meaningless)
  CONSTRAINT availability_exceptions_open_chk CHECK (kind = 'CLOSED' OR start_min IS NOT NULL)
);
CREATE INDEX availability_exceptions_location_idx ON scheduling.availability_exceptions (location_id, end_date) WHERE location_id IS NOT NULL;
CREATE INDEX availability_exceptions_resource_idx ON scheduling.availability_exceptions (resource_id, end_date) WHERE resource_id IS NOT NULL;

-- ===== Reservations: the SINGLE source of "this resource is occupied during this time" =================
-- Provider-created BLOCKs (walk-ins, maintenance) exist now; customer BOOKINGs are added by the booking
-- phase through the same table, so ONE exclusion constraint guards against every kind of double-booking.
-- `occupied` already includes the service buffer.
CREATE TABLE scheduling.resource_reservations (
  id          uuid PRIMARY KEY,
  resource_id uuid        NOT NULL REFERENCES provider.bookable_resources (id),
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  occupied    tstzrange   GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  kind        text        NOT NULL CHECK (kind IN ('BLOCK', 'BOOKING')),
  status      text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
  booking_id  uuid,
  reason      text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT resource_reservations_range_chk CHECK (end_at > start_at),
  CONSTRAINT resource_reservations_whole_minutes_chk CHECK (
    date_part('second', start_at) = 0 AND date_part('second', end_at) = 0
  ),
  CONSTRAINT resource_reservations_no_overlap EXCLUDE USING gist (resource_id WITH =, occupied WITH &&) WHERE (status = 'ACTIVE')
);
CREATE INDEX resource_reservations_resource_time_idx ON scheduling.resource_reservations USING gist (resource_id, occupied) WHERE status = 'ACTIVE';

-- ===== Booking policy (scope: platform default, overridable per provider) =============================
CREATE TABLE scheduling.booking_policies (
  id                   uuid PRIMARY KEY,
  scope_type           text        NOT NULL CHECK (scope_type IN ('PLATFORM', 'PROVIDER')),
  provider_id          uuid        REFERENCES provider.providers (id),
  slot_granularity_min smallint    CHECK (slot_granularity_min IN (5, 10, 15, 20, 30, 60)),
  min_lead_time_min    integer     CHECK (min_lead_time_min BETWEEN 0 AND 10080),
  max_advance_days     smallint    CHECK (max_advance_days BETWEEN 1 AND 365),
  response_deadline_min integer    CHECK (response_deadline_min BETWEEN 5 AND 1440),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_policies_scope_chk CHECK (
    (scope_type = 'PLATFORM' AND provider_id IS NULL) OR (scope_type = 'PROVIDER' AND provider_id IS NOT NULL)
  ),
  -- The platform row is the fallback of last resort: it must define every setting.
  CONSTRAINT booking_policies_platform_complete_chk CHECK (
    scope_type <> 'PLATFORM' OR (
      slot_granularity_min IS NOT NULL AND min_lead_time_min IS NOT NULL
      AND max_advance_days IS NOT NULL AND response_deadline_min IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX booking_policies_scope_key ON scheduling.booking_policies
  (scope_type, COALESCE(provider_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Configuration, not code (requirements §8 rule 8): sensible platform defaults, changeable at runtime.
INSERT INTO scheduling.booking_policies
  (id, scope_type, provider_id, slot_granularity_min, min_lead_time_min, max_advance_days, response_deadline_min)
VALUES ('00000000-0000-7000-8000-000000000301', 'PLATFORM', NULL, 15, 60, 30, 30);

-- ===== Staff skills: which services a stylist can perform ===============================================
CREATE TABLE catalog.resource_services (
  resource_id         uuid NOT NULL REFERENCES provider.bookable_resources (id) ON DELETE CASCADE,
  provider_service_id uuid NOT NULL REFERENCES catalog.provider_services (id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, provider_service_id)
);
CREATE INDEX resource_services_service_idx ON catalog.resource_services (provider_service_id);

-- ===== Permissions for scheduling ==========================================================================
INSERT INTO identity.permissions (code, description) VALUES
  ('schedule:manage', 'Manage working hours, breaks, leave and time blocks'),
  ('schedule:read',   'View working hours, breaks, leave and time blocks');

INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PROVIDER_OWNER',   'schedule:manage'),
  ('PROVIDER_OWNER',   'schedule:read'),
  ('PROVIDER_MANAGER', 'schedule:manage'),
  ('PROVIDER_MANAGER', 'schedule:read'),
  ('PROVIDER_STAFF',   'schedule:read')
) AS p(role_code, code) ON p.role_code = r.code;

-- ===== Search read-model (owned by the geo-search module) ==============================================
-- Views are the sanctioned way for search to read other modules' data (docs §D.2 rule 3): one place that
-- states exactly what is publicly discoverable. A provider appears ONLY if APPROVED, and a location only
-- if ACTIVE and not deleted — so suspension/deletion removes it from discovery immediately.
CREATE VIEW search.location_listing AS
SELECT l.id            AS location_id,
       l.provider_id,
       p.display_name  AS provider_name,
       p.description   AS provider_description,
       l.name          AS location_name,
       l.address_line1, l.address_line2, l.city, l.state, l.postal_code, l.country,
       l.geog,
       l.timezone,
       NULL::numeric   AS rating_avg,   -- filled by the reviews phase
       0::integer      AS rating_count
  FROM provider.provider_locations l
  JOIN provider.providers p ON p.id = l.provider_id
 WHERE l.deleted_at IS NULL AND l.status = 'ACTIVE'
   AND p.deleted_at IS NULL AND p.status = 'APPROVED';

CREATE VIEW search.location_service AS
SELECT loc.location_id,
       ps.id AS provider_service_id,
       ps.provider_id,
       ps.name,
       ps.description,
       ps.price_minor,
       ps.currency,
       ps.duration_min,
       ps.buffer_min,
       st.id   AS service_type_id,
       st.code AS service_type_code,
       c.id    AS category_id,
       c.code  AS category_code
  FROM search.location_listing loc
  JOIN catalog.provider_services ps ON ps.provider_id = loc.provider_id AND ps.is_active AND ps.deleted_at IS NULL
  JOIN catalog.service_types st ON st.id = ps.service_type_id AND st.is_active
  JOIN catalog.categories c ON c.id = st.category_id AND c.is_active;

CREATE VIEW search.location_resource AS
SELECT r.id AS resource_id, r.location_id, r.display_name
  FROM provider.bookable_resources r
  JOIN search.location_listing loc ON loc.location_id = r.location_id
 WHERE r.is_active AND r.kind = 'STAFF';

CREATE VIEW search.resource_skill AS
SELECT rs.resource_id, rs.provider_service_id FROM catalog.resource_services rs;

-- Down Migration
