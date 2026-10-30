-- Up Migration
-- Ratings and reviews (requirements §5/§6/§21): only for a booking that really happened (settled), one per booking, moderated by
-- administrators, answerable once by the business. The per-location aggregate feeds discovery (search shows the rating).
CREATE SCHEMA IF NOT EXISTS reviews;

CREATE TABLE reviews.reviews (
  id            uuid        PRIMARY KEY,
  booking_id    uuid        NOT NULL UNIQUE REFERENCES booking.bookings (id),
  customer_id   uuid        NOT NULL REFERENCES identity.users (id),
  provider_id   uuid        NOT NULL REFERENCES provider.providers (id),
  location_id   uuid        NOT NULL REFERENCES provider.provider_locations (id),
  -- A snapshot: the review keeps saying what was booked even if the service is renamed or removed later.
  service_name  text        NOT NULL,
  rating        smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       text        CHECK (comment IS NULL OR length(comment) <= 1000),
  status        text        NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED', 'HIDDEN')),
  hidden_reason text,
  hidden_by     uuid,
  hidden_at     timestamptz,
  reply         text        CHECK (reply IS NULL OR length(reply) <= 1000),
  replied_by    uuid,
  replied_at    timestamptz,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  CONSTRAINT reviews_hidden_chk CHECK ((status = 'HIDDEN') = (hidden_at IS NOT NULL))
);
CREATE INDEX reviews_location_idx ON reviews.reviews (location_id, id DESC) WHERE status = 'PUBLISHED';
CREATE INDEX reviews_provider_idx ON reviews.reviews (provider_id, id DESC);
CREATE INDEX reviews_status_idx   ON reviews.reviews (status, id DESC);

-- Per-location aggregate over PUBLISHED reviews only, maintained in the same transaction as every change.
CREATE TABLE reviews.location_ratings (
  location_id  uuid        PRIMARY KEY REFERENCES provider.provider_locations (id),
  review_count integer     NOT NULL CHECK (review_count >= 0),
  rating_sum   integer     NOT NULL CHECK (rating_sum >= 0),
  updated_at   timestamptz NOT NULL
);

-- Discovery shows the rating. Same columns and types as before (the placeholder is replaced, nothing else changes).
CREATE OR REPLACE VIEW search.location_listing AS
SELECT l.id            AS location_id,
       l.provider_id,
       p.display_name  AS provider_name,
       p.description   AS provider_description,
       l.name          AS location_name,
       l.address_line1, l.address_line2, l.city, l.state, l.postal_code, l.country,
       l.geog,
       l.timezone,
       CASE WHEN r.review_count > 0 THEN round(r.rating_sum::numeric / r.review_count, 2) END AS rating_avg,
       coalesce(r.review_count, 0)::integer AS rating_count
  FROM provider.provider_locations l
  JOIN provider.providers p ON p.id = l.provider_id
  LEFT JOIN reviews.location_ratings r ON r.location_id = l.id
 WHERE l.deleted_at IS NULL AND l.status = 'ACTIVE'
   AND p.deleted_at IS NULL AND p.status = 'APPROVED';

INSERT INTO identity.permissions (code, description) VALUES
  ('review:read',     'Read the reviews of own business'),
  ('review:reply',    'Reply to a review of own business'),
  ('review:moderate', 'Hide or restore reviews (administration)');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PROVIDER_OWNER',   'review:read'),
  ('PROVIDER_OWNER',   'review:reply'),
  ('PROVIDER_MANAGER', 'review:read'),
  ('PROVIDER_MANAGER', 'review:reply'),
  ('PLATFORM_ADMIN',   'review:moderate'),
  ('SUPPORT_OPERATOR', 'review:moderate')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
