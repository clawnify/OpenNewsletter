/**
 * The send engine: one `deliveries` row per recipient, sent in batches of 100,
 * resumable after anything short of losing the database.
 *
 * It replaced a loop that posted one email per recipient inside the operator's
 * HTTP request and recorded nothing per person. That loop broke in three ways
 * that grow with the list: four parallel requests outran the provider's
 * 10 req/s default and the 429s were counted as failures and never retried;
 * closing the tab mid-send stopped it with no record of who had been mailed,
 * so a retry mailed everyone again; and the issue was marked `sent` even when
 * every recipient failed.
 *
 * The rules this module keeps:
 *
 *  - **Who gets the issue is decided once.** `beginSend` snapshots the issue
 *    (content, design, settings, sender) and writes a row per confirmed
 *    subscriber, numbered into fixed batches, in one statement. Later edits to
 *    the issue, the settings or the list don't change what a send delivers.
 *
 *  - **A key that may have delivered is never given up.** Each attempt is sent
 *    under an idempotency key stored on its rows. Once any attempt under a key
 *    has an unknown outcome (a timeout, a 5xx, a worker that died while its
 *    request was in flight: rows are marked `in_flight` just before the call)
 *    the key is marked risky and every later attempt for those rows reuses it,
 *    so the provider deduplicates instead of mailing them twice. A refusal on
 *    a later attempt proves only that *that* attempt sent nothing, so it does
 *    not clear the mark. A key that was only ever refused is dropped with the
 *    claim, so a retry can't be answered with a cached refusal. Risky rows are
 *    never given new keys (not split into single sends, not resent with a
 *    changed snapshot): when that is the only way forward, they are recorded
 *    "may have been delivered" instead.
 *
 *  - **Deduplication has an expiry.** The provider remembers a key for 24
 *    hours. A risky key older than KEY_TTL_MS is not retried: its rows are
 *    recorded failed with a message that they may have been delivered.
 *    Retrying would risk a duplicate the provider can no longer catch.
 *
 *  - **Ownership is read back, never counted.** The storage layer runs
 *    statements one at a time with no transactions, and one of its bindings
 *    reports no change counts at all. So a claim writes a fresh token and
 *    `RETURNING`s the rows it took; every later write for that attempt is
 *    guarded by the token.
 *
 *  - **"Unknown" is not "failed".** Unknown rows stay claimed and are retried
 *    under the same key once the claim goes stale, at most MAX_RETRIES times.
 */
import { query, get, run } from "./db";
import { renderEmailHtml } from "./render";
import { fillSubject, type MergeValues } from "../shared/merge";
import type { BatchMessage, BatchOutcome, EmailProvider } from "./providers";
import type { DesignTokens } from "../shared/design";
import type { Mail, Settings } from "../shared/types";

export const BATCH_SIZE = 100;
/** A claim this old with no outcome recorded means the worker holding it died. */
export const STALE_CLAIM_MS = 10 * 60_000;
/** Retries of a risky key before its rows are recorded failed. */
export const MAX_RETRIES = 3;
/** Resend keeps idempotency keys for 24h; stop trusting one well before that. */
export const KEY_TTL_MS = 23 * 60 * 60_000;
/** Longest single wait on a 429 before giving the rows back and yielding. */
const MAX_RATE_WAIT_MS = 10_000;

const MAYBE_DELIVERED = "The provider never confirmed this message. It may have been delivered.";

/** Mirrors schema.sql, for installs whose database predates the table. */
export const DELIVERIES_DDL = [
  `CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    mail_id INTEGER NOT NULL,
    contact_id TEXT NOT NULL,
    email TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    batch INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
    claim_token TEXT,
    claimed_at TEXT,
    send_key TEXT,
    key_at TEXT,
    key_risky INTEGER NOT NULL DEFAULT 0,
    in_flight INTEGER NOT NULL DEFAULT 0,
    single INTEGER NOT NULL DEFAULT 0,
    retries INTEGER NOT NULL DEFAULT 0,
    provider_message_id TEXT,
    error TEXT,
    sent_at TEXT,
    delivered_at TEXT,
    opened_at TEXT,
    clicked_at TEXT,
    bounced_at TEXT,
    bounce_permanent INTEGER NOT NULL DEFAULT 0,
    bounce_reason TEXT,
    complained_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_recipient ON deliveries(mail_id, contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_batch ON deliveries(mail_id, status, batch)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_provider ON deliveries(provider_message_id)
     WHERE provider_message_id IS NOT NULL`,
];

/** Everything a send needs, frozen at the moment it starts. */
export interface SendSnapshot {
  /** Content only. The send's own fields (status, send_snapshot, ...) are left out so a retry snapshots the same thing. */
  mail: Omit<Mail, "conversation" | "status" | "scheduled_at" | "sent_at" | "updated_at">;
  design: DesignTokens;
  settings: Settings;
  from: string;
  /** The app's own origin, for unsubscribe links. */
  origin: string;
  /**
   * Which renderer the send was begun with. Absent means 1, from before merge
   * tags. A retried key must carry the exact payload it first carried, so a
   * send renders with its own version even after the app is upgraded. Bump it
   * whenever the same mail would render to different HTML.
   */
  renderer?: 2 | 3;
}

export type BeginResult =
  | { ok: true; sendId: string; resumed: boolean }
  | { ok: false; reason: "already-sent" | "not-found" };

export interface SendProgress {
  status: "sending" | "sent" | "failed";
  sent: number;
  failed: number;
  skipped: number;
  /** Rows not yet resolved: waiting, or claimed with no answer yet. */
  open: number;
  error: string | null;
}

export interface DrainOptions {
  /** Epoch ms after which to stop starting work. Absent = run to completion. */
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadline?: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const token = () => crypto.randomUUID().replace(/-/g, "");

/**
 * Start a send, or pick up the one already running.
 *
 * - draft / scheduled: claimed, snapshotted, recipients written.
 * - sending: resumed as-is (the snapshot is kept so a retried key sends the
 *   same payload it sent the first time).
 * - failed: resumed with a fresh snapshot, since a failed send stopped on
 *   something the operator was meant to fix (the key, the sender). Delivered
 *   rows stay delivered; only unresolved rows go out.
 * - sent: refused.
 */
export async function beginSend(mailId: number, audienceId: string, snapshot: SendSnapshot): Promise<BeginResult> {
  const sendId = crypto.randomUUID();
  const claimed = await query<{ id: number }>(
    `UPDATE mails SET status = 'sending', send_id = ?, send_snapshot = ?, send_error = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND status IN ('draft', 'scheduled')
      RETURNING id`,
    [sendId, JSON.stringify(snapshot), mailId],
  );
  if (claimed.length > 0) {
    await writeRecipients(mailId, audienceId);
    return { ok: true, sendId, resumed: false };
  }

  const row = await get<{ status: string; send_id: string | null }>(
    `SELECT status, send_id FROM mails WHERE id = ?`,
    [mailId],
  );
  if (!row) return { ok: false, reason: "not-found" };
  if (row.status === "sent") return { ok: false, reason: "already-sent" };
  if ((row.status !== "sending" && row.status !== "failed") || !row.send_id) return { ok: false, reason: "not-found" };

  if (row.status === "failed") {
    const next = JSON.stringify(snapshot);
    const prev = await get<{ send_snapshot: string | null }>(`SELECT send_snapshot FROM mails WHERE id = ?`, [mailId]);
    if (prev?.send_snapshot !== next) {
      // A risky key only deduplicates the exact payload it first carried. With
      // a new snapshot those rows can't be retried safely.
      await run(
        `UPDATE deliveries SET status = 'failed', error = ?, claim_token = NULL, in_flight = 0
          WHERE mail_id = ? AND key_risky = 1 AND status IN ('pending', 'sending')`,
        [MAYBE_DELIVERED, mailId],
      );
    }
    // Rows written before names were copied have none. Rows never attempted
    // carry no payload yet, so they can take the names now.
    await run(
      `UPDATE deliveries SET first_name = (SELECT first_name FROM contacts WHERE id = deliveries.contact_id),
                             last_name = (SELECT last_name FROM contacts WHERE id = deliveries.contact_id)
        WHERE mail_id = ? AND first_name IS NULL AND key_risky = 0 AND status IN ('pending', 'failed')`,
      [mailId],
    );
    await run(
      `UPDATE mails SET status = 'sending', send_snapshot = ?, send_error = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'failed'`,
      [next, mailId],
    );
  }
  // A worker that died between the claim and writing recipients leaves a send
  // with no rows; writeRecipients is a no-op when they exist.
  await writeRecipients(mailId, audienceId);
  return { ok: true, sendId: row.send_id, resumed: true };
}

/**
 * One row per confirmed subscriber, numbered into fixed batches. A single
 * statement guarded by NOT EXISTS, so two concurrent starts can't both write
 * (a count-then-insert could, and a late subscriber could then land in a batch
 * that was already claimed).
 */
async function writeRecipients(mailId: number, audienceId: string): Promise<void> {
  await run(
    `INSERT OR IGNORE INTO deliveries (id, mail_id, contact_id, email, first_name, last_name, batch)
     SELECT 'dlv_' || lower(hex(randomblob(16))), ?, id, email, first_name, last_name,
            CAST((ROW_NUMBER() OVER (ORDER BY created_at, id) - 1) / ? AS INTEGER)
       FROM contacts
      WHERE audience_id = ? AND status = 'subscribed'
        AND NOT EXISTS (SELECT 1 FROM deliveries WHERE mail_id = ?)`,
    [mailId, BATCH_SIZE, audienceId, mailId],
  );
}

/**
 * Work through the send until every row is resolved, the deadline passes, or
 * the provider refuses the send outright. Safe to run concurrently with
 * itself: rows are claimed, not read.
 */
export async function drainSend(mailId: number, provider: EmailProvider, opts: DrainOptions = {}): Promise<SendProgress> {
  const clock: Clock = { now: opts.now ?? Date.now, sleep: opts.sleep ?? defaultSleep, deadline: opts.deadline };

  const mail = await get<{ status: string; send_id: string | null; send_snapshot: string | null }>(
    `SELECT status, send_id, send_snapshot FROM mails WHERE id = ?`,
    [mailId],
  );
  if (!mail || mail.status !== "sending" || !mail.send_id || !mail.send_snapshot) return progress(mailId);
  const snap = JSON.parse(mail.send_snapshot) as SendSnapshot;

  for (;;) {
    if (clock.deadline !== undefined && clock.now() >= clock.deadline) break;
    const claim = await claimNext(mailId, mail.send_id, clock.now());
    if (!claim) break;
    if (claim.rows.length === 0) continue;

    const result = await sendClaim(claim, snap, provider, clock);
    if (result.stop === "fatal") {
      await run(
        `UPDATE mails SET status = 'failed', send_error = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'sending'`,
        [result.message, mailId],
      );
      return progress(mailId);
    }
    if (result.stop === "yield") break;
  }
  return finishIfDone(mailId, clock.now());
}

interface ClaimedRow {
  id: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  send_key: string;
  key_risky: number;
  single: number;
}

interface Claim {
  mailId: number;
  token: string;
  rows: ClaimedRow[];
}

/**
 * Take the next batch: orphaned claims first (so a stuck batch can't starve),
 * then waiting rows. Returns null when nothing is left to take.
 */
async function claimNext(mailId: number, sendId: string, nowMs: number): Promise<Claim | null> {
  const stale = iso(nowMs - STALE_CLAIM_MS);
  const next = await get<{ batch: number }>(
    `SELECT batch FROM deliveries
      WHERE mail_id = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))
      ORDER BY status = 'pending', batch LIMIT 1`,
    [mailId, stale],
  );
  if (!next) return null;

  const t = token();
  // One statement takes the batch. A stale row whose request was in flight
  // when its worker died has an unknown outcome, so its key becomes risky; a
  // stale row that never reached the provider stays as it was. A risky key
  // being tried again counts a retry. Rows never attempted get a fresh key.
  const taken = await query<{ id: string }>(
    `UPDATE deliveries
        SET key_risky = CASE WHEN status = 'sending' AND in_flight = 1 THEN 1 ELSE key_risky END,
            retries = retries + CASE WHEN (status = 'sending' AND in_flight = 1) OR key_risky = 1 THEN 1 ELSE 0 END,
            in_flight = 0,
            status = 'sending', claim_token = ?, claimed_at = ?,
            key_at = CASE WHEN send_key IS NULL THEN ? ELSE key_at END,
            send_key = COALESCE(send_key, ?)
      WHERE mail_id = ? AND batch = ?
        AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))
      RETURNING id`,
    [t, iso(nowMs), iso(nowMs), `opennewsletter/${sendId}/${next.batch}/${t.slice(0, 8)}`, mailId, next.batch, stale],
  );
  if (taken.length === 0) return { mailId, token: t, rows: [] };

  // Rows whose risky key can't be retried safely any more: too many retries,
  // or older than the provider's memory of it.
  await run(
    `UPDATE deliveries SET status = 'failed', error = ?, claim_token = NULL
      WHERE claim_token = ? AND key_risky = 1 AND (retries > ? OR key_at < ?)`,
    [MAYBE_DELIVERED, t, MAX_RETRIES, iso(nowMs - KEY_TTL_MS)],
  );
  // Drop anyone who left since the send began, but only rows never attempted:
  // a retried key must carry exactly the recipients it carried first.
  await run(
    `UPDATE deliveries SET status = 'skipped', error = 'Unsubscribed before this issue reached them.', claim_token = NULL
      WHERE claim_token = ? AND key_risky = 0 AND retries = 0
        AND contact_id NOT IN (SELECT id FROM contacts WHERE status = 'subscribed')`,
    [t],
  );

  const rows = await query<ClaimedRow>(
    `SELECT id, contact_id, email, first_name, last_name, send_key, key_risky, single FROM deliveries
      WHERE claim_token = ? AND status = 'sending' ORDER BY id`,
    [t],
  );
  return { mailId, token: t, rows };
}

type StepResult = { stop?: undefined } | { stop: "fatal"; message: string } | { stop: "yield" };

async function sendClaim(claim: Claim, snap: SendSnapshot, provider: EmailProvider, clock: Clock): Promise<StepResult> {
  // Rows already split into single sends (after a batch was rejected for one
  // bad message) keep going one by one under their own keys.
  const singles = claim.rows.filter((r) => r.single === 1);
  const grouped = claim.rows.filter((r) => r.single !== 1);

  if (grouped.length > 0) {
    const messages = grouped.map((r) => renderFor(snap, r));
    await markInFlight(claim.token, grouped.map((r) => r.id));
    const outcome = await sendWithWaits(provider, snap, messages, grouped[0].send_key, clock);
    switch (outcome.kind) {
      case "sent":
        await markSent(claim.token, grouped.map((r, i) => [r.id, outcome.ids[i] ?? null]), clock.now());
        break;
      case "invalid": {
        if (grouped[0].key_risky === 1) {
          // An earlier attempt under this key may have landed. Singles would
          // need new keys, which the provider can't match to it.
          await run(
            `UPDATE deliveries SET status = 'failed', error = ?, claim_token = NULL, in_flight = 0
              WHERE claim_token = ? AND single = 0`,
            [`${MAYBE_DELIVERED} Retrying it was rejected: ${outcome.message}`, claim.token],
          );
          break;
        }
        // Rejected as a whole for one message, so nothing went out under this
        // key: split into single sends, each under its own key.
        await run(
          `UPDATE deliveries SET single = 1, in_flight = 0, key_at = ?, send_key = send_key || '/' || id
            WHERE claim_token = ? AND single = 0`,
          [iso(clock.now()), claim.token],
        );
        const split = await query<ClaimedRow>(
          `SELECT id, contact_id, email, first_name, last_name, send_key, key_risky, single FROM deliveries
            WHERE claim_token = ? AND status = 'sending' AND single = 1 ORDER BY id`,
          [claim.token],
        );
        return sendSingles(claim.token, split, snap, provider, clock, { accountCheck: true, mailId: claim.mailId });
      }
      case "rate_limited":
        await release(claim.token);
        return { stop: "yield" };
      case "fatal":
        return (await release(claim.token)) ? { stop: "fatal", message: outcome.message } : { stop: "yield" };
      case "in_progress":
      case "unknown":
        await markUnknown(claim.token, grouped.map((r) => r.id), outcome.kind === "unknown" ? outcome.message : "In progress elsewhere");
        break;
    }
  }
  if (singles.length > 0) return sendSingles(claim.token, singles, snap, provider, clock, { accountCheck: false, mailId: claim.mailId });
  return {};
}

/**
 * Send rows one at a time, each through the same outcome handling as a batch.
 * `accountCheck`: right after a batch rejection, if *every* message is
 * rejected with the same reason, nothing in this send has ever been accepted,
 * and the reason isn't about the recipient, the problem is the account or the
 * sender: stop the send rather than fail the whole list. (Resend's message
 * for a bad `to` doesn't name the address, so "all the same" alone would also
 * match a batch of several bad addresses.)
 */
async function sendSingles(
  claimToken: string,
  rows: ClaimedRow[],
  snap: SendSnapshot,
  provider: EmailProvider,
  clock: Clock,
  opts: { accountCheck: boolean; mailId: number },
): Promise<StepResult> {
  const rejected: { id: string; message: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    await markInFlight(claimToken, [r.id]);
    const outcome = await sendWithWaits(provider, snap, [renderFor(snap, r)], r.send_key, clock);
    switch (outcome.kind) {
      case "sent":
        await markSent(claimToken, [[r.id, outcome.ids[0] ?? null]], clock.now());
        break;
      case "invalid":
        rejected.push({ id: r.id, message: outcome.message });
        break;
      case "rate_limited":
        await release(claimToken);
        return { stop: "yield" };
      case "fatal":
        return (await release(claimToken)) ? { stop: "fatal", message: outcome.message } : { stop: "yield" };
      case "in_progress":
      case "unknown":
        await markUnknown(claimToken, [r.id], outcome.kind === "unknown" ? outcome.message : "In progress elsewhere");
        break;
    }
  }

  if (
    opts.accountCheck &&
    rows.length > 1 &&
    rejected.length === rows.length &&
    rejected.every((x) => x.message === rejected[0].message) &&
    !/`to`/.test(rejected[0].message) &&
    !(await get(`SELECT 1 AS x FROM deliveries WHERE mail_id = ? AND status = 'sent' LIMIT 1`, [opts.mailId]))
  ) {
    if (await release(claimToken)) return { stop: "fatal", message: rejected[0].message };
    return { stop: "yield" };
  }
  for (const x of rejected) {
    await run(`UPDATE deliveries SET status = 'failed', error = ?, claim_token = NULL, in_flight = 0 WHERE id = ? AND claim_token = ?`, [
      x.message,
      x.id,
      claimToken,
    ]);
  }
  return {};
}

/** One provider call, waiting out 429s while the deadline allows. Same key throughout. */
async function sendWithWaits(
  provider: EmailProvider,
  snap: SendSnapshot,
  messages: BatchMessage[],
  idempotencyKey: string,
  clock: Clock,
): Promise<BatchOutcome> {
  const input = { from: snap.from, subject: snap.mail.title, messages, idempotencyKey };
  let outcome = await provider.sendBatch(input);
  while (outcome.kind === "rate_limited") {
    const wait = Math.min(outcome.retryAfterMs, MAX_RATE_WAIT_MS);
    if (clock.deadline !== undefined && clock.now() + wait >= clock.deadline) return outcome;
    await clock.sleep(wait);
    outcome = await provider.sendBatch(input);
  }
  return outcome;
}

function renderFor(snap: SendSnapshot, r: ClaimedRow): BatchMessage {
  // The contact id is a UUID, so the link is unguessable and unsubscribes only this person.
  const unsubscribeUrl = `${snap.origin}/api/unsubscribe?c=${r.contact_id}`;
  // From the row, not the contact: a name edited mid-send must not change a
  // payload that may be retried under the same key.
  const version = snap.renderer ?? 1;
  const v2 = version >= 2;
  const merge: MergeValues | undefined = v2
    ? { first_name: r.first_name ?? "", last_name: r.last_name ?? "", email: r.email }
    : undefined;
  const html = renderEmailHtml(snap.mail as Mail, snap.design, snap.settings, {
    unsubscribeUrl,
    mobile: snap.mail.design_mobile,
    merge,
    legacyColumns: !v2,
    legacyFooter: version < 3,
  });
  const subject = fillSubject(snap.mail.title, merge);
  return { to: r.email, html, unsubscribeUrl, deliveryId: r.id, ...(subject !== snap.mail.title ? { subject } : {}) };
}

/** One statement for the whole batch: per-row UPDATEs would spend a subrequest per recipient. */
async function markSent(claimToken: string, pairs: [string, string | null][], nowMs: number): Promise<void> {
  if (pairs.length === 0) return;
  const payload = JSON.stringify(pairs);
  await run(
    `UPDATE deliveries SET status = 'sent', sent_at = ?, error = NULL, claim_token = NULL, in_flight = 0,
            provider_message_id = (SELECT json_extract(j.value, '$[1]') FROM json_each(?) j
                                    WHERE json_extract(j.value, '$[0]') = deliveries.id)
      WHERE claim_token = ? AND id IN (SELECT json_extract(value, '$[0]') FROM json_each(?))`,
    [iso(nowMs), payload, claimToken, payload],
  );
}

/**
 * No trustworthy answer. The rows stay claimed (so they go stale and are
 * retried later) and their key becomes risky, so every retry reuses it.
 */
async function markUnknown(claimToken: string, ids: string[], message: string): Promise<void> {
  await run(
    `UPDATE deliveries SET key_risky = 1, in_flight = 0, error = ?
      WHERE claim_token = ? AND id IN (SELECT value FROM json_each(?))`,
    [message, claimToken, JSON.stringify(ids)],
  );
}

/** Just before a provider call: if this worker dies now, the outcome is unknown. */
async function markInFlight(claimToken: string, ids: string[]): Promise<void> {
  await run(`UPDATE deliveries SET in_flight = 1 WHERE claim_token = ? AND id IN (SELECT value FROM json_each(?))`, [
    claimToken,
    JSON.stringify(ids),
  ]);
}

/**
 * This attempt sent nothing: hand the rows back to waiting. A key that was
 * ever risky stays on its rows (an earlier attempt under it may have landed);
 * any other key is dropped, so the next attempt can't meet a cached refusal.
 * The retry this claim counted is given back: a refusal tested nothing.
 * Returns false when the claim was no longer ours (another worker took it
 * over), in which case this worker must not stop the send.
 */
async function release(claimToken: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE deliveries
        SET status = 'pending', claim_token = NULL, claimed_at = NULL, in_flight = 0,
            retries = MAX(0, retries - key_risky),
            send_key = CASE WHEN key_risky = 1 THEN send_key ELSE NULL END,
            key_at = CASE WHEN key_risky = 1 THEN key_at ELSE NULL END,
            single = CASE WHEN key_risky = 1 THEN single ELSE 0 END
      WHERE claim_token = ? AND status = 'sending'
      RETURNING id`,
    [claimToken],
  );
  return rows.length > 0;
}

async function finishIfDone(mailId: number, nowMs: number): Promise<SendProgress> {
  const p = await progress(mailId);
  if (p.status !== "sending" || p.open > 0) return p;
  // Guarded on status, so only the first worker to see the send finished writes.
  await run(
    `UPDATE mails SET status = ?, sent_at = ?, scheduled_at = NULL, send_error = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'sending'`,
    [
      p.sent > 0 ? "sent" : "failed",
      iso(nowMs),
      p.sent > 0 ? null : p.failed > 0 ? "No recipient could be sent this issue." : "No confirmed subscribers were left to send to.",
      mailId,
    ],
  );
  return progress(mailId);
}

/** Where a send stands, from the rows themselves. */
export async function progress(mailId: number): Promise<SendProgress> {
  const mail = await get<{ status: string; send_error: string | null }>(
    `SELECT status, send_error FROM mails WHERE id = ?`,
    [mailId],
  );
  const counts = await query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM deliveries WHERE mail_id = ? GROUP BY status`,
    [mailId],
  );
  const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
  const status = mail?.status === "sent" || mail?.status === "failed" ? mail.status : "sending";
  return {
    status,
    sent: n("sent"),
    failed: n("failed"),
    skipped: n("skipped"),
    open: n("pending") + n("sending"),
    error: mail?.send_error ?? null,
  };
}
