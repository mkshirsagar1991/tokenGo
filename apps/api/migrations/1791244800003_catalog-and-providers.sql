-- Up Migration
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS provider;

-- Categories & service types are configuration, never hard-coded (requirements §7/§8 rule 8). -------
CREATE TABLE catalog.categories (
  id                uuid PRIMARY KEY,
  code              text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name              text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description       text,
  is_active         boolean     NOT NULL DEFAULT false,
  booking_flow_type text        NOT NULL DEFAULT 'APPOINTMENT_SLOT'
    CHECK (booking_flow_type IN ('APPOINTMENT_SLOT', 'TABLE_RESERVATION', 'SERVICE_REQUEST_WINDOW', 'TEST_ORDER_WITH_COLLECTION')),
  config            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sort_order        integer     NOT NULL DEFAULT 0,
  version           integer     NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_code_key UNIQUE (code)
);
CREATE TRIGGER categories_updated_at BEFORE UPDATE ON catalog.categories
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE catalog.service_types (
  id               uuid PRIMARY KEY,
  category_id      uuid        NOT NULL REFERENCES catalog.categories (id),
  code             text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description      text,
  attribute_schema jsonb       NOT NULL DEFAULT '{}'::jsonb,
  is_active        boolean     NOT NULL DEFAULT true,
  sort_order       integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_types_code_key UNIQUE (category_id, code)
);
CREATE TRIGGER service_types_updated_at BEFORE UPDATE ON catalog.service_types
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Providers ------------------------------------------------------------------------------------
CREATE TABLE provider.providers (
  id               uuid PRIMARY KEY,
  owner_user_id    uuid        NOT NULL REFERENCES identity.users (id),
  display_name     text        NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  description      text,
  status           text        NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED')),
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       uuid,
  decision_reason  text,
  version          integer     NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX providers_owner_idx ON provider.providers (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX providers_status_idx ON provider.providers (status) WHERE deleted_at IS NULL;
CREATE TRIGGER providers_updated_at BEFORE UPDATE ON provider.providers
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

CREATE TABLE provider.provider_locations (
  id            uuid PRIMARY KEY,
  provider_id   uuid        NOT NULL REFERENCES provider.providers (id),
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  address_line1 text        NOT NULL,
  address_line2 text,
  city          text        NOT NULL,
  state         text        NOT NULL,
  postal_code   text        NOT NULL,
  country       char(2)     NOT NULL DEFAULT 'IN',
  -- geography(Point, 4326): metres-accurate ST_DWithin / ST_Distance (docs §H.1)
  geog          geography(Point, 4326) NOT NULL,
  timezone      text        NOT NULL DEFAULT 'Asia/Kolkata',
  status        text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX provider_locations_provider_idx ON provider.provider_locations (provider_id) WHERE deleted_at IS NULL;
CREATE INDEX provider_locations_geog_gix ON provider.provider_locations USING gist (geog);
CREATE TRIGGER provider_locations_updated_at BEFORE UPDATE ON provider.provider_locations
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Schedulable thing. A stylist is a STAFF resource; future verticals add TABLE/ROOM/... (docs §D.4).
CREATE TABLE provider.bookable_resources (
  id           uuid PRIMARY KEY,
  location_id  uuid        NOT NULL REFERENCES provider.provider_locations (id),
  kind         text        NOT NULL DEFAULT 'STAFF' CHECK (kind IN ('STAFF', 'TABLE', 'ROOM', 'VEHICLE_BAY')),
  display_name text        NOT NULL,
  is_active    boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookable_resources_location_idx ON provider.bookable_resources (location_id) WHERE is_active;
CREATE TRIGGER bookable_resources_updated_at BEFORE UPDATE ON provider.bookable_resources
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Staff. user_id stays NULL until an invited person accepts with the invited phone number (no account
-- is created for someone who has not consented; docs §N). Staff with neither (a stylist whose calendar
-- the owner manages) are valid: they simply never log in.
CREATE TABLE provider.provider_staff (
  id                 uuid PRIMARY KEY,
  provider_id        uuid        NOT NULL REFERENCES provider.providers (id),
  location_id        uuid        NOT NULL REFERENCES provider.provider_locations (id),
  user_id            uuid        REFERENCES identity.users (id),
  invited_phone_hash text,
  resource_id        uuid        REFERENCES provider.bookable_resources (id),
  display_name       text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  staff_role         text        NOT NULL DEFAULT 'STAFF' CHECK (staff_role IN ('MANAGER', 'STAFF')),
  status             text        NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'INACTIVE')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX provider_staff_provider_idx ON provider.provider_staff (provider_id) WHERE deleted_at IS NULL;
CREATE INDEX provider_staff_location_idx ON provider.provider_staff (location_id) WHERE deleted_at IS NULL;
CREATE INDEX provider_staff_user_idx ON provider.provider_staff (user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX provider_staff_invite_idx ON provider.provider_staff (invited_phone_hash)
  WHERE user_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX provider_staff_user_location_key ON provider.provider_staff (location_id, user_id)
  WHERE user_id IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER provider_staff_updated_at BEFORE UPDATE ON provider.provider_staff
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Provider service catalogue. All price/duration data lives here and is the ONLY trusted source
-- (requirements §9). `version` is bumped on any price/duration change so bookings can snapshot it.
CREATE TABLE catalog.provider_services (
  id              uuid PRIMARY KEY,
  provider_id     uuid        NOT NULL REFERENCES provider.providers (id),
  service_type_id uuid        NOT NULL REFERENCES catalog.service_types (id),
  name            text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description     text,
  price_minor     bigint      NOT NULL CHECK (price_minor >= 0),
  currency        char(3)     NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  duration_min    integer     NOT NULL CHECK (duration_min BETWEEN 5 AND 1440),
  buffer_min      integer     NOT NULL DEFAULT 0 CHECK (buffer_min BETWEEN 0 AND 240),
  is_active       boolean     NOT NULL DEFAULT true,
  attributes      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX provider_services_provider_idx ON catalog.provider_services (provider_id) WHERE deleted_at IS NULL;
CREATE INDEX provider_services_type_idx ON catalog.provider_services (service_type_id) WHERE deleted_at IS NULL AND is_active;
CREATE TRIGGER provider_services_updated_at BEFORE UPDATE ON catalog.provider_services
  FOR EACH ROW EXECUTE FUNCTION platform.set_updated_at();

-- Down Migration
