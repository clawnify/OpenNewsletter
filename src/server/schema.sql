-- Newsletter mails (Ghost calls these "posts").
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eyebrow TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Untitled',
  -- Inbox preview line (preheader), rendered hidden as the body's first child.
  preheader TEXT NOT NULL DEFAULT '',
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
  status TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | sending | sent | failed
  broadcast_id TEXT,
  scheduled_at TEXT,
  sent_at TEXT,
  -- Set when a send starts (see src/server/sending.ts). The snapshot is what
  -- the send delivers, so edits made while it runs can't change it.
  send_id TEXT,
  send_snapshot TEXT,
  send_error TEXT,
  -- 'inactive': an ask to subscribers who stopped reading (src/server/sunset.ts).
  -- Recipients are the audience's inactive subscribers when the send starts, and
  -- the ones who stay silent are removed GRACE_DAYS later (sunset_done_at then set).
  segment TEXT,
  segment_days INTEGER,
  sunset_done_at TEXT,
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
  footer_text TEXT NOT NULL DEFAULT '',
  -- The Resend webhook "Turn on delivery tracking" registered, and its signing
  -- secret (verifies events; RESEND_WEBHOOK_SECRET in the env wins).
  resend_webhook_id TEXT,
  resend_webhook_secret TEXT,
  -- Which sibling app (from GET /v1/apps/directory) the operator picked as the
  -- contacts source, NULL = none. This IS the opt-in: a CRM being reachable never
  -- activates anything on its own; the operator chooses one in Settings before
  -- any CRM read happens. Falls back to the CRM_APP_ID env var (bundle installs).
  crm_app_id TEXT,
  -- When delivery tracking was turned on: engagement data starts here, so
  -- nobody can look inactive for longer than tracking has been watching.
  tracking_since TEXT,
  -- Set once past opens and clicks were copied onto contacts.last_engaged_at.
  engagement_backfilled_at TEXT
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
  -- Confirmation emails: when the last one went out (null = never, e.g. added
  -- by hand or the send failed), how many in all, and why the last one failed.
  -- The link expires 7 days after its email; reminders stop after 3 emails.
  confirm_sent_at TEXT,
  confirm_attempts INTEGER NOT NULL DEFAULT 0,
  confirm_error TEXT,
  -- Last open, click or keep-link click from this address (src/server/sunset.ts).
  last_engaged_at TEXT,
  -- Why an unsubscribed row is unsubscribed when it wasn't the person's own
  -- choice: 'inactive' (sunset). NULL = they unsubscribed or complained.
  unsubscribe_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Public signups per caller in the last hour, IP stored hashed. Pruned on every
-- signup; only used for the rate limit on /api/subscribe.
CREATE TABLE IF NOT EXISTS signup_attempts (
  ip_hash TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signup_attempts ON signup_attempts(ip_hash, at);
CREATE INDEX IF NOT EXISTS idx_signup_attempts_at ON signup_attempts(at);

-- One row per recipient of a send: who it went to, whether it arrived at the
-- provider, and the provider's message id (which bounce and complaint events
-- refer to). Written once when the send starts, in fixed batches of 100. See
-- src/server/sending.ts for the claim and idempotency-key rules.
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  mail_id INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  email TEXT NOT NULL,
  -- Merge-tag values as they were when the send started, like the email.
  first_name TEXT,
  last_name TEXT,
  batch INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  -- Who holds the row right now, and since when (a stale claim is retried).
  claim_token TEXT,
  claimed_at TEXT,
  -- The idempotency key this row is sent under, when it was minted, and
  -- whether an attempt under it may have delivered (then it is never dropped).
  send_key TEXT,
  key_at TEXT,
  key_risky INTEGER NOT NULL DEFAULT 0,
  -- 1 while a provider call for this row is under way; a stale claim with it set had an unknown outcome.
  in_flight INTEGER NOT NULL DEFAULT 0,
  -- 1 once the row is sent on its own, after its batch was rejected for one bad message.
  single INTEGER NOT NULL DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error TEXT,
  sent_at TEXT,
  -- Delivery events from the provider's webhook (src/server/events.ts).
  delivered_at TEXT,
  opened_at TEXT,
  clicked_at TEXT,
  bounced_at TEXT,
  bounce_permanent INTEGER NOT NULL DEFAULT 0,
  bounce_reason TEXT,
  complained_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_recipient ON deliveries(mail_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_batch ON deliveries(mail_id, status, batch);
CREATE INDEX IF NOT EXISTS idx_deliveries_provider ON deliveries(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
-- What one person received, for "5 issues since they last engaged".
CREATE INDEX IF NOT EXISTS idx_deliveries_contact ON deliveries(contact_id, sent_at);

-- ── Automations (flows) ──────────────────────────────────────────────────────
-- A flow is a small chain of steps a contact walks once: send an email, wait,
-- send another. The design rule, lifted from the Klaviyo teardown
-- (~/wiki/OpenNewsletter/klaviyo-flows-teardown.md §11): the ENROLLMENT ROW is
-- the truth and a queued job is only a wake-up that re-checks it, because the
-- platform queue is at-least-once and a job can't be cancelled once enqueued.
-- See src/server/flows.ts for the engine; these mirror its FLOWS_DDL.

-- One automation. trigger_type is immutable after creation (the merge-tag and
-- condition vocabulary depend on it); the target audience can change while the
-- flow has no live enrollments.
CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'live', 'paused', 'archived')),
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('subscribed', 'date_anniversary', 'api_event')),
  -- {audience_id, consent_sources:[...]} etc. Shape depends on trigger_type.
  trigger_config TEXT NOT NULL DEFAULT '{}',
  reentry TEXT NOT NULL DEFAULT 'none'
    CHECK (reentry IN ('none', 'always', 'after')),
  reentry_after_seconds INTEGER,
  entry_step_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Steps are nodes with stable ids, NEVER hard-deleted while a waiter could
-- point at one: a delete is a tombstone plus forward_to_step_id, so a waking
-- enrollment finds its step gone and follows the forward link to the next live
-- step instead of being dropped.
CREATE TABLE IF NOT EXISTS flow_steps (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  -- 'split' is reserved: the engine (src/server/flows.ts) does not act on it in
  -- v1, but it is in the CHECK from day one so adding multi-branch splits later
  -- never needs a per-app table rebuild to widen the constraint.
  kind TEXT NOT NULL CHECK (kind IN ('email', 'delay', 'split', 'end')),
  -- email: {mail_id}        a mails row, copied from a template, rendered at send time
  -- delay: {seconds}        at_time / weekdays reserved for later; v1 is duration only
  -- split: {paths, else}    reserved; not yet instantiable
  config TEXT NOT NULL DEFAULT '{}',
  next_step_id TEXT,              -- email/delay point forward; end is terminal
  deleted_at TEXT,               -- tombstone
  forward_to_step_id TEXT,       -- where waiters go when this step was deleted
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_flow_steps_flow ON flow_steps(flow_id);

-- One contact's single journey through one flow.
CREATE TABLE IF NOT EXISTS flow_enrollments (
  id TEXT PRIMARY KEY,
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'completed', 'exited')),
  current_step_id TEXT NOT NULL,     -- the one step they are scheduled for
  due_at TEXT NOT NULL,              -- frozen when they arrived at this step
  wake_seq INTEGER NOT NULL DEFAULT 0,-- bumped on every (re)schedule; stale wakes no-op
  trigger_payload TEXT NOT NULL DEFAULT '{}', -- merge-value snapshot
  exit_reason TEXT,                  -- unsubscribed | bounced | flow_archived | contact_deleted | unsupported_step
  entered_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- At most one live journey per contact per flow. Re-entry is a new row after
-- the old one ends.
CREATE UNIQUE INDEX IF NOT EXISTS idx_enroll_active
  ON flow_enrollments(flow_id, contact_id) WHERE state = 'waiting';
CREATE INDEX IF NOT EXISTS idx_enroll_due ON flow_enrollments(state, due_at);
CREATE INDEX IF NOT EXISTS idx_enroll_step ON flow_enrollments(current_step_id, state);

-- Append-only per-step outcomes: analytics, skip reasons, and send idempotency.
CREATE TABLE IF NOT EXISTS flow_step_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id TEXT NOT NULL REFERENCES flow_enrollments(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  outcome TEXT NOT NULL,          -- sent | skipped | exited
  detail TEXT,                    -- skip/exit reason, or the provider message id
  created_at TEXT DEFAULT (datetime('now'))
);
-- A step sends at most once per enrollment, whatever the queue redelivers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_sent_once
  ON flow_step_events(enrollment_id, step_id) WHERE outcome = 'sent';

CREATE INDEX IF NOT EXISTS idx_mails_status ON mails(status);
CREATE INDEX IF NOT EXISTS idx_mails_updated ON mails(updated_at);
CREATE INDEX IF NOT EXISTS idx_mails_sunset ON mails(segment) WHERE sunset_done_at IS NULL;
-- One row per address per list; re-subscribing updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(audience_id, email);
-- Drives "who gets this send" — the only hot query on this table.
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(audience_id, status);
CREATE INDEX IF NOT EXISTS idx_contacts_crm ON contacts(audience_id, crm_contact_id)
  WHERE crm_contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_confirm
  ON contacts(confirm_token) WHERE confirm_token IS NOT NULL;
-- Audience view pages newest first (src/server/contacts.ts pageContacts).
CREATE INDEX IF NOT EXISTS idx_contacts_created ON contacts(audience_id, created_at, id);
