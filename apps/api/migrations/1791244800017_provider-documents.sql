-- Up Migration
-- Provider verification documents (requirements §6/§21): uploaded by the business, reviewed by an administrator. The file itself
-- lives in object storage under an unguessable key and is only ever served through an authorised API call.

CREATE TABLE provider.documents (
  id            uuid        PRIMARY KEY,
  provider_id   uuid        NOT NULL REFERENCES provider.providers (id),
  doc_type      text        NOT NULL CHECK (doc_type IN ('ID_PROOF', 'BUSINESS_REGISTRATION', 'ADDRESS_PROOF', 'TAX_REGISTRATION', 'OTHER')),
  status        text        NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED', 'VERIFIED', 'REJECTED')),
  storage_key   text        NOT NULL UNIQUE,
  content_type  text        NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    integer     NOT NULL CHECK (size_bytes > 0),
  sha256        text        NOT NULL,
  -- Display only: sanitised and never used as a path.
  original_name text        CHECK (original_name IS NULL OR length(original_name) <= 100),
  uploaded_by   uuid        NOT NULL,
  created_at    timestamptz NOT NULL,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  review_note   text        CHECK (review_note IS NULL OR length(review_note) <= 500),
  deleted_at    timestamptz,
  CONSTRAINT documents_review_chk CHECK ((status = 'UPLOADED') = (reviewed_at IS NULL))
);
CREATE INDEX documents_provider_idx ON provider.documents (provider_id, created_at DESC) WHERE deleted_at IS NULL;

INSERT INTO identity.permissions (code, description) VALUES
  ('document:manage', 'Upload, view and delete the verification documents of own business'),
  ('document:review', 'Open and decide on any business''s verification documents (administration)');
INSERT INTO identity.role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM identity.roles r
JOIN (VALUES
  ('PROVIDER_OWNER', 'document:manage'),
  ('PLATFORM_ADMIN', 'document:review')
) AS p(role_code, code) ON p.role_code = r.code;

-- Down Migration
-- Intentionally empty: migrations are forward-only (docs §G.8).
