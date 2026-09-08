-- Newsletter mails (Ghost calls these "posts").
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eyebrow TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Untitled',
  subtitle TEXT NOT NULL DEFAULT '',
  byline_name TEXT NOT NULL DEFAULT '',
  byline_date TEXT NOT NULL DEFAULT '',
  feature_image TEXT NOT NULL DEFAULT '',
  -- Body as an ordered JSON array of blocks.
  blocks TEXT NOT NULL DEFAULT '[]',
  -- Per-mail DESIGN.md token overrides (JSON), or NULL to inherit template/default.
  design TEXT,
  -- Mobile-only token overrides (partial JSON), layered on top of `design` when device=mobile.
  design_mobile TEXT,
  template_slug TEXT,
  -- Resend segment (audience) id this mail targets.
  audience_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | sent
  broadcast_id TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Reusable look + content skeleton. Built-ins are seeded, plus user "Save as.." presets.
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL,     -- DESIGN.md tokens (JSON)
  skeleton TEXT NOT NULL,   -- content skeleton (JSON)
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Single-row app configuration (id is always 1).
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  publication_name TEXT NOT NULL DEFAULT 'My Newsletter',
  logo TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  default_audience_id TEXT,
  footer_text TEXT NOT NULL DEFAULT ''
);

-- Audiences (lists). Previously Resend segments; now local, so the list is the
-- publication's own data rather than something living in a third-party account.
-- The id doubles as the `list_key` sent to Clawnify's suppression ledger, so it
-- MUST be stable for the life of the list — a changing key silently detaches
-- every prior unsubscribe and starts mailing people who opted out.
CREATE TABLE IF NOT EXISTS audiences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Contacts.
--
-- `status` exists because consent is a state, never something implied by the
-- row existing. A contact imported from a CRM or a CSV has not agreed to
-- receive marketing; it lands `pending` and only an explicit opt-in moves it to
-- `subscribed`. This is the difference between a list you can defend and one
-- that quietly generates spam complaints — which, on shared sending
-- infrastructure, degrade deliverability for every other publication too.
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  audience_id TEXT NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'subscribed', 'unsubscribed', 'bounced')),
  -- How consent was obtained, and the evidence for it. Kept because "when did
  -- this person agree, and how" is the question you must answer on request.
  consent_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (consent_source IN ('signup_form', 'import', 'manual', 'crm_sync')),
  consent_at TEXT,
  consent_evidence TEXT NOT NULL DEFAULT '',
  -- Double opt-in token; cleared once confirmed.
  confirm_token TEXT,
  unsubscribed_at TEXT,
  -- Set when the row was imported from the workspace's CRM: the CRM keeps the
  -- person, this row keeps the consent, and the id lets unsubscribes report
  -- back to the CRM timeline.
  crm_contact_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mails_status ON mails(status);
CREATE INDEX IF NOT EXISTS idx_mails_updated ON mails(updated_at);
-- One row per address per list; re-subscribing updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(audience_id, email);
-- Drives "who gets this send" — the only hot query on this table.
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(audience_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_crm ON contacts(audience_id, crm_contact_id)
  WHERE crm_contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_confirm
  ON contacts(confirm_token) WHERE confirm_token IS NOT NULL;
