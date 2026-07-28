/**
 * Audiences and contacts, stored locally in D1.
 *
 * These used to live in a Resend account, which meant the publication's own
 * subscriber list sat in a third-party system the rest of the app couldn't
 * reason about. Keeping them here makes the list the publication's data:
 * queryable alongside mails, exportable, and reachable by other apps.
 *
 * The one rule this module exists to enforce: **consent is a state, never
 * implied by a row existing.** Adding someone creates a `pending` contact;
 * only an explicit opt-in makes them `subscribed`, and only `subscribed`
 * contacts are ever returned as send recipients.
 *
 * Follows the package's raw-SQL API — `initDB(c.env)` runs in middleware, so
 * these helpers call query/get/run directly without threading a handle.
 */
import { query, get, run } from "./db";

export type ContactStatus = "pending" | "subscribed" | "unsubscribed" | "bounced";
export type ConsentSource = "signup_form" | "import" | "manual" | "crm_sync";

export interface Audience {
  id: string;
  name: string;
  description: string;
  subscribed_count?: number;
  created_at: string;
}

export interface Contact {
  id: string;
  audience_id: string;
  email: string;
  first_name: string;
  last_name: string;
  status: ContactStatus;
  consent_source: ConsentSource;
  consent_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
}

const CONTACT_COLS =
  "id, audience_id, email, first_name, last_name, status, consent_source, consent_at, unsubscribed_at, created_at";

const now = () => new Date().toISOString();
const normalize = (email: string) => email.trim().toLowerCase();

// ── Audiences ───────────────────────────────────────────────────────────────

export async function listAudiences(): Promise<Audience[]> {
  return (await query(
    `SELECT a.id, a.name, a.description, a.created_at,
            (SELECT COUNT(*) FROM contacts c
              WHERE c.audience_id = a.id AND c.status = 'subscribed') AS subscribed_count
       FROM audiences a ORDER BY a.created_at`,
    [],
  )) as unknown as Audience[];
}

export async function createAudience(name: string, description = ""): Promise<Audience> {
  const id = `aud_${crypto.randomUUID().replace(/-/g, "")}`;
  await run(`INSERT INTO audiences (id, name, description) VALUES (?, ?, ?)`, [
    id,
    name,
    description,
  ]);
  return (await get(`SELECT * FROM audiences WHERE id = ?`, [id])) as Audience;
}

/** Every publication needs at least one list; create one on first use. */
export async function defaultAudience(): Promise<Audience> {
  const existing = (await get(
    `SELECT * FROM audiences ORDER BY created_at LIMIT 1`,
    [],
  )) as Audience | null;
  return existing ?? (await createAudience("Subscribers"));
}

// ── Contacts ────────────────────────────────────────────────────────────────

export async function listContacts(audienceId: string): Promise<Contact[]> {
  return (await query(
    `SELECT ${CONTACT_COLS} FROM contacts WHERE audience_id = ? ORDER BY created_at DESC`,
    [audienceId],
  )) as unknown as Contact[];
}

/**
 * Add a contact directly (operator action or import).
 *
 * Defaults to `pending`, not `subscribed`. Callers that genuinely hold proof of
 * consent — a signup form the person submitted, a migrated list with recorded
 * opt-in — pass it explicitly along with the evidence. Making the safe case the
 * default is the point: the unsafe case should require saying so.
 */
export async function addContact(
  audienceId: string,
  input: { email: string; first_name?: string; last_name?: string },
  consent: { source: ConsentSource; status?: ContactStatus; evidence?: string } = {
    source: "manual",
  },
): Promise<Contact> {
  const email = normalize(input.email);
  const status: ContactStatus = consent.status ?? "pending";

  const existing = (await get(`SELECT * FROM contacts WHERE audience_id = ? AND email = ?`, [
    audienceId,
    email,
  ])) as Contact | null;

  if (existing) {
    // Never silently resurrect someone who opted out — that is precisely the
    // re-import that generates spam complaints. They must opt in again.
    if (existing.status === "unsubscribed") return existing;
    await run(
      `UPDATE contacts SET first_name = ?, last_name = ?, status = ?,
              consent_source = ?, consent_at = ?, consent_evidence = ?
         WHERE id = ?`,
      [
        input.first_name ?? existing.first_name,
        input.last_name ?? existing.last_name,
        status,
        consent.source,
        status === "subscribed" ? (existing.consent_at ?? now()) : existing.consent_at,
        consent.evidence ?? "",
        existing.id,
      ],
    );
    return (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`, [
      existing.id,
    ])) as Contact;
  }

  const id = `con_${crypto.randomUUID().replace(/-/g, "")}`;
  await run(
    `INSERT INTO contacts (id, audience_id, email, first_name, last_name, status,
                           consent_source, consent_at, consent_evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      audienceId,
      email,
      input.first_name ?? "",
      input.last_name ?? "",
      status,
      consent.source,
      status === "subscribed" ? now() : null,
      consent.evidence ?? "",
    ],
  );
  return (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`, [id])) as Contact;
}

export async function removeContact(audienceId: string, contactId: string): Promise<void> {
  await run(`DELETE FROM contacts WHERE audience_id = ? AND id = ?`, [audienceId, contactId]);
}

/**
 * The recipients of a send. Deliberately the only way to get an address list:
 * `pending` (never confirmed), `unsubscribed` and `bounced` are all excluded,
 * so no caller can accidentally mail them by writing its own query.
 */
export async function subscribedRecipients(audienceId: string): Promise<Contact[]> {
  return (await query(
    `SELECT ${CONTACT_COLS} FROM contacts
      WHERE audience_id = ? AND status = 'subscribed' ORDER BY created_at`,
    [audienceId],
  )) as unknown as Contact[];
}

// ── Consent transitions ─────────────────────────────────────────────────────

/**
 * Begin a double opt-in. Returns the token to put in the confirmation email.
 * Re-submitting an existing pending signup issues a fresh token rather than
 * erroring, so a lost confirmation email is self-service to fix.
 */
export async function startSignup(
  audienceId: string,
  input: { email: string; first_name?: string },
): Promise<{ contact: Contact; token: string } | { alreadySubscribed: true }> {
  const email = normalize(input.email);
  const existing = (await get(`SELECT * FROM contacts WHERE audience_id = ? AND email = ?`, [
    audienceId,
    email,
  ])) as Contact | null;

  if (existing?.status === "subscribed") return { alreadySubscribed: true };

  const token = crypto.randomUUID().replace(/-/g, "");
  const contact =
    existing ??
    (await addContact(audienceId, input, { source: "signup_form", status: "pending" }));

  await run(
    `UPDATE contacts SET confirm_token = ?, status = 'pending',
            consent_source = 'signup_form', first_name = ?
       WHERE id = ?`,
    [token, input.first_name ?? contact.first_name, contact.id],
  );
  return { contact, token };
}

/** Complete a double opt-in. The token is single-use — cleared on success. */
export async function confirmSignup(token: string, evidence = ""): Promise<Contact | null> {
  const contact = (await get(`SELECT * FROM contacts WHERE confirm_token = ?`, [
    token,
  ])) as Contact | null;
  if (!contact) return null;

  await run(
    `UPDATE contacts SET status = 'subscribed', consent_at = ?, consent_evidence = ?,
            confirm_token = NULL, unsubscribed_at = NULL
       WHERE id = ?`,
    [now(), evidence, contact.id],
  );
  return (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`, [
    contact.id,
  ])) as Contact;
}

export async function markUnsubscribed(audienceId: string, email: string): Promise<void> {
  await run(
    `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = ?, confirm_token = NULL
       WHERE audience_id = ? AND email = ? AND status <> 'unsubscribed'`,
    [now(), audienceId, normalize(email)],
  );
}

/**
 * Reconcile local contacts with the platform's suppression ledger.
 *
 * The ledger is the enforcement layer — it is what the send path actually
 * checks, and a recipient who unsubscribes does so there, not here. Without
 * pulling those back, the subscriber list shown to the publication drifts into
 * claiming people are subscribed when every send to them is refused.
 * Returns how many local rows changed.
 */
export async function applySuppressions(audienceId: string, emails: string[]): Promise<number> {
  if (emails.length === 0) return 0;
  const lowered = emails.map(normalize);
  const placeholders = lowered.map(() => "?").join(",");

  const affected = (await query(
    `SELECT id FROM contacts
      WHERE audience_id = ? AND status <> 'unsubscribed' AND email IN (${placeholders})`,
    [audienceId, ...lowered],
  )) as unknown as { id: string }[];
  if (affected.length === 0) return 0;

  await run(
    `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = ?, confirm_token = NULL
      WHERE id IN (${affected.map(() => "?").join(",")})`,
    [now(), ...affected.map((r) => r.id)],
  );
  return affected.length;
}
