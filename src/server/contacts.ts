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
  /** Waiting to confirm. */
  pending_count?: number;
  /** Waiting, and no confirmation email has ever gone out (added by hand, or the send failed). */
  pending_unsent?: number;
  /** Waiting, emailed over a day ago, and still owed a reminder. */
  pending_due?: number;
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
  crm_contact_id: string | null;
  /** When the last confirmation email went out; null if none ever did. */
  confirm_sent_at: string | null;
  confirm_attempts: number;
  /** Why the last confirmation email couldn't be sent. */
  confirm_error: string | null;
  created_at: string;
}

const CONTACT_COLS =
  "id, audience_id, email, first_name, last_name, status, consent_source, consent_at, unsubscribed_at, crm_contact_id, confirm_sent_at, confirm_attempts, confirm_error, created_at";

/** A confirmation link stops working this long after its email was sent. */
export const CONFIRM_TTL_MS = 7 * 24 * 3600_000;
/** A repeat signup inside this window reuses the email already sent, instead of mailing the address again. */
export const CONFIRM_COOLDOWN_MS = 10 * 60_000;
/** A pending contact is owed a reminder this long after the last confirmation email… */
export const REMIND_AFTER_MS = 24 * 3600_000;
/** …up to this many confirmation emails in all (the first plus two reminders). */
export const MAX_CONFIRM_EMAILS = 3;

const now = () => new Date().toISOString();
const normalize = (email: string) => email.trim().toLowerCase();

// ── Audiences ───────────────────────────────────────────────────────────────

export async function listAudiences(nowMs: number = Date.now()): Promise<Audience[]> {
  return (await query(
    `SELECT a.id, a.name, a.description, a.created_at,
            (SELECT COUNT(*) FROM contacts c
              WHERE c.audience_id = a.id AND c.status = 'subscribed') AS subscribed_count,
            (SELECT COUNT(*) FROM contacts c
              WHERE c.audience_id = a.id AND c.status = 'pending') AS pending_count,
            (SELECT COUNT(*) FROM contacts c
              WHERE c.audience_id = a.id AND c.status = 'pending' AND c.confirm_sent_at IS NULL) AS pending_unsent,
            (SELECT COUNT(*) FROM contacts c
              WHERE c.audience_id = a.id AND c.status = 'pending' AND c.confirm_sent_at < ?
                AND c.confirm_attempts < ?) AS pending_due
       FROM audiences a ORDER BY a.created_at, a.rowid`,
    [new Date(nowMs - REMIND_AFTER_MS).toISOString(), MAX_CONFIRM_EMAILS],
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

/**
 * Every publication needs at least one list; create one on first use.
 *
 * One statement, so it is safe when a fresh install's first page load fires
 * several requests at once. Reading first and inserting after made each of
 * them see an empty table and create its own "Subscribers".
 */
export async function defaultAudience(): Promise<Audience> {
  await run(
    `INSERT INTO audiences (id, name, description)
     SELECT ?, 'Subscribers', '' WHERE NOT EXISTS (SELECT 1 FROM audiences)`,
    [`aud_${crypto.randomUUID().replace(/-/g, "")}`],
  );
  // rowid breaks the tie between lists created in the same second.
  return (await get(`SELECT * FROM audiences ORDER BY created_at, rowid LIMIT 1`, [])) as Audience;
}

/**
 * Remove the extra "Subscribers" lists the old first-use race created: same
 * name and second as the first list, and nothing anywhere points at them (no
 * contacts, no mail, not the default, no flow trigger). A list someone put people in or chose
 * stays, even if it is one of them. Idempotent; runs at boot.
 */
export async function dropDuplicateDefaultAudiences(): Promise<void> {
  await run(
    `DELETE FROM audiences
      WHERE name = 'Subscribers' AND description = ''
        AND rowid <> (SELECT rowid FROM audiences ORDER BY created_at, rowid LIMIT 1)
        AND created_at = (SELECT created_at FROM audiences ORDER BY created_at, rowid LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM contacts WHERE contacts.audience_id = audiences.id)
        AND NOT EXISTS (SELECT 1 FROM mails WHERE mails.audience_id = audiences.id)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE settings.default_audience_id = audiences.id)
        AND NOT EXISTS (SELECT 1 FROM flows WHERE json_extract(flows.trigger_config, '$.audience_id') = audiences.id)`,
  );
}

// ── Contacts ────────────────────────────────────────────────────────────────

export async function listContacts(audienceId: string): Promise<Contact[]> {
  return (await query(
    `SELECT ${CONTACT_COLS} FROM contacts WHERE audience_id = ? ORDER BY created_at DESC`,
    [audienceId],
  )) as unknown as Contact[];
}

export async function findContact(audienceId: string, email: string): Promise<Contact | null> {
  return (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE audience_id = ? AND email = ?`, [
    audienceId,
    normalize(email),
  ])) as Contact | null;
}

/** Status of each address that is in the audience; absent = not in it. */
export async function statusesOf(audienceId: string, emails: string[]): Promise<Map<string, ContactStatus>> {
  if (!emails.length) return new Map();
  const rows = (await query(
    `SELECT email, status FROM contacts
      WHERE audience_id = ? AND email IN (SELECT value FROM json_each(?))`,
    [audienceId, JSON.stringify(emails.map(normalize))],
  )) as unknown as { email: string; status: ContactStatus }[];
  return new Map(rows.map((r) => [r.email, r.status]));
}

/**
 * One page of an audience, newest first, optionally searched (email or name)
 * and filtered by status. `cursor` is the `next` of the previous page.
 */
export async function pageContacts(
  audienceId: string,
  opts: { search?: string; status?: string; cursor?: string; limit: number },
): Promise<{ contacts: Contact[]; next: string | null }> {
  const where = [`audience_id = ?`];
  const params: unknown[] = [audienceId];
  const term = opts.search?.trim().toLowerCase();
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(email LIKE ? ESCAPE '\\' OR lower(first_name) LIKE ? ESCAPE '\\' OR lower(last_name) LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (opts.status && ["pending", "subscribed", "unsubscribed", "bounced"].includes(opts.status)) {
    where.push(`status = ?`);
    params.push(opts.status);
  }
  const sep = opts.cursor?.lastIndexOf("|") ?? -1;
  if (opts.cursor && sep > 0) {
    const at = opts.cursor.slice(0, sep);
    where.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
    params.push(at, at, opts.cursor.slice(sep + 1));
  }
  params.push(opts.limit + 1);
  const rows = (await query(
    `SELECT ${CONTACT_COLS} FROM contacts WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    params,
  )) as unknown as Contact[];
  const more = rows.length > opts.limit;
  const page = more ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];
  return { contacts: page, next: more && last ? `${last.created_at}|${last.id}` : null };
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
  input: { email: string; first_name?: string; last_name?: string; crm_contact_id?: string },
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
    // re-import that generates spam complaints. They must opt in again. Nor an
    // address that hard-bounced: re-importing it only bounces again, and bounce
    // rates are what mailbox providers judge a sender by.
    if (existing.status === "unsubscribed" || existing.status === "bounced") return existing;
    // Consent only moves forward. A subscriber added again (by hand, or from
    // the CRM) stays subscribed with the record of how they first agreed: that
    // record is what answers "when did this person opt in". A pending row only
    // changes its consent fields when this call brings consent.
    const upgrade = existing.status === "pending" && status === "subscribed";
    await run(
      `UPDATE contacts SET first_name = ?, last_name = ?,
              crm_contact_id = COALESCE(?, crm_contact_id)
         WHERE id = ?`,
      [
        input.first_name ?? existing.first_name,
        input.last_name ?? existing.last_name,
        input.crm_contact_id ?? null,
        existing.id,
      ],
    );
    if (upgrade) {
      await run(
        `UPDATE contacts SET status = 'subscribed', consent_source = ?, consent_at = ?, consent_evidence = ?
           WHERE id = ? AND status = 'pending'`,
        [consent.source, now(), consent.evidence ?? "", existing.id],
      );
    }
    return (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`, [
      existing.id,
    ])) as Contact;
  }

  const id = `con_${crypto.randomUUID().replace(/-/g, "")}`;
  await run(
    `INSERT INTO contacts (id, audience_id, email, first_name, last_name, status,
                           consent_source, consent_at, consent_evidence, crm_contact_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.crm_contact_id ?? null,
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
 * Begin a double opt-in. Returns the token to put in the confirmation email,
 * and whether to send one.
 *
 * A repeat signup reuses the token already issued, so every confirmation email
 * this person has received keeps working. Inside CONFIRM_COOLDOWN_MS it sends
 * nothing new: the form is public, and without that anyone could fill one
 * inbox with confirmation emails by submitting the same address in a loop.
 */
export async function startSignup(
  audienceId: string,
  input: { email: string; first_name?: string },
  nowMs: number = Date.now(),
): Promise<{ contact: Contact; token: string; send: boolean } | { alreadySubscribed: true }> {
  const email = normalize(input.email);
  const existing = (await get(`SELECT * FROM contacts WHERE audience_id = ? AND email = ?`, [
    audienceId,
    email,
  ])) as (Contact & { confirm_token: string | null }) | null;

  if (existing?.status === "subscribed") return { alreadySubscribed: true };

  const contact =
    existing ??
    ({ ...(await addContact(audienceId, input, { source: "signup_form", status: "pending" })), confirm_token: null } as Contact & {
      confirm_token: string | null;
    });

  const sentAt = contact.confirm_sent_at ? Date.parse(contact.confirm_sent_at) : null;
  const live = !!contact.confirm_token && sentAt !== null && nowMs - sentAt < CONFIRM_TTL_MS;
  const token = live ? contact.confirm_token! : crypto.randomUUID().replace(/-/g, "");
  const send = !(live && sentAt !== null && nowMs - sentAt < CONFIRM_COOLDOWN_MS);

  await run(
    `UPDATE contacts SET confirm_token = ?, status = 'pending',
            consent_source = 'signup_form', first_name = ?
       WHERE id = ?`,
    [token, input.first_name ?? contact.first_name, contact.id],
  );
  return { contact, token, send };
}

/**
 * Pending contacts owed a confirmation email: never sent one, or sent one over
 * a day ago and still under MAX_CONFIRM_EMAILS. Each gets a live token (an
 * expired one is replaced). Bounded, so one request can't fan out without end.
 */
export async function confirmationsDue(
  audienceId: string,
  limit: number,
  nowMs: number = Date.now(),
): Promise<{ id: string; email: string; token: string; attempts: number }[]> {
  const rows = (await query(
    `SELECT id, email, confirm_token, confirm_sent_at, confirm_attempts FROM contacts
      WHERE audience_id = ? AND status = 'pending'
        AND (confirm_sent_at IS NULL OR (confirm_sent_at < ? AND confirm_attempts < ?))
      ORDER BY created_at LIMIT ?`,
    [audienceId, new Date(nowMs - REMIND_AFTER_MS).toISOString(), MAX_CONFIRM_EMAILS, limit],
  )) as unknown as { id: string; email: string; confirm_token: string | null; confirm_sent_at: string | null; confirm_attempts: number }[];

  const out: { id: string; email: string; token: string; attempts: number }[] = [];
  for (const r of rows) {
    const sentAt = r.confirm_sent_at ? Date.parse(r.confirm_sent_at) : null;
    let token = r.confirm_token;
    if (!token || sentAt === null || nowMs - sentAt >= CONFIRM_TTL_MS) {
      token = crypto.randomUUID().replace(/-/g, "");
      await run(`UPDATE contacts SET confirm_token = ? WHERE id = ?`, [token, r.id]);
    }
    out.push({ id: r.id, email: r.email, token, attempts: Number(r.confirm_attempts) });
  }
  return out;
}

/** A confirmation email went out (or failed to): what the audience view reports. */
export async function recordConfirmation(contactId: string, result: { error?: string }, nowMs: number = Date.now()): Promise<void> {
  if (result.error) {
    await run(`UPDATE contacts SET confirm_error = ? WHERE id = ?`, [result.error.slice(0, 500), contactId]);
    return;
  }
  await run(
    `UPDATE contacts SET confirm_sent_at = ?, confirm_attempts = confirm_attempts + 1, confirm_error = NULL WHERE id = ?`,
    [new Date(nowMs).toISOString(), contactId],
  );
}

/** Look a token up without using it: the confirmation page shows who it's for before anyone presses the button. */
export async function peekConfirmation(
  token: string,
  nowMs: number = Date.now(),
): Promise<{ contact: Contact } | { expired: true } | null> {
  const contact = (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE confirm_token = ?`, [token])) as Contact | null;
  if (!contact) return null;
  const sentAt = contact.confirm_sent_at ? Date.parse(contact.confirm_sent_at) : null;
  if (sentAt !== null && nowMs - sentAt >= CONFIRM_TTL_MS) return { expired: true };
  return { contact };
}

/** Complete a double opt-in. The token is single-use — cleared on success. */
export async function confirmSignup(token: string, evidence = "", nowMs: number = Date.now()): Promise<Contact | null> {
  const peek = await peekConfirmation(token, nowMs);
  if (!peek || "expired" in peek) return null;
  const contact = peek.contact;

  await run(
    `UPDATE contacts SET status = 'subscribed', consent_at = ?, consent_evidence = ?,
            confirm_token = NULL, unsubscribed_at = NULL, confirm_error = NULL
       WHERE id = ? AND confirm_token = ?`,
    [new Date(nowMs).toISOString(), evidence, contact.id, token],
  );
  return (await get(`SELECT ${CONTACT_COLS} FROM contacts WHERE id = ?`, [
    contact.id,
  ])) as Contact;
}

// ── Signup rate limit ───────────────────────────────────────────────────────

/** Signups one address (IP) may start per hour. Generous for a shared office, tight for a script. */
export const SIGNUPS_PER_IP_PER_HOUR = 10;

/**
 * Count a signup from this caller and say whether it's within the limit. The
 * IP is stored hashed and kept for an hour, only for this count.
 */
export async function allowSignup(ip: string, nowMs: number = Date.now()): Promise<boolean> {
  const hour = new Date(nowMs - 3600_000).toISOString();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const ipHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  await run(`DELETE FROM signup_attempts WHERE at < ?`, [hour]);
  const n = (await get(`SELECT COUNT(*) AS n FROM signup_attempts WHERE ip_hash = ? AND at >= ?`, [ipHash, hour])) as {
    n: number;
  } | null;
  if (Number(n?.n ?? 0) >= SIGNUPS_PER_IP_PER_HOUR) return false;
  await run(`INSERT INTO signup_attempts (ip_hash, at) VALUES (?, ?)`, [ipHash, new Date(nowMs).toISOString()]);
  return true;
}

export async function markUnsubscribed(audienceId: string, email: string): Promise<void> {
  await run(
    `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = ?, confirm_token = NULL
       WHERE audience_id = ? AND email = ? AND status <> 'unsubscribed'`,
    [now(), audienceId, normalize(email)],
  );
}
