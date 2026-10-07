/**
 * Sunsetting: ask subscribers who stopped reading whether they still want the
 * newsletter, and stop mailing the ones who don't answer.
 *
 * Every vendor that does this makes it opt-in, and Buttondown refuses it
 * outright because tracking can be blocked, which makes real readers look
 * inactive (~/wiki/OpenNewsletter/sunset-inactive.md). So every rule here errs
 * toward keeping someone:
 * - opens count as engagement although Apple Mail fakes them;
 * - nobody is inactive until 5 issues have been sent to them since they last
 *   engaged, joined, or since tracking was turned on;
 * - nobody is removed without an email with a keep link first, and only once
 *   their copy is `sent` and GRACE_DAYS have passed with no sign of life;
 * - the whole thing is refused when no open or click has been recorded lately.
 *
 * The ask is an ordinary issue with `segment = 'inactive'`. Removal needs no
 * job and no cron (a deployed app can't own one): `finishSunsets` is one
 * idempotent statement per ask, run from the request middleware.
 */
import { get, query, run } from "./db";

export const INACTIVE_DAYS = 90;
export const MIN_RECEIVED = 5;
export const GRACE_DAYS = 10;
const DAY = 24 * 3600_000;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Contacts on one audience who count as inactive at `cutoff` (an ISO time:
 * quiet since before it). Params, in order: tracking_since, audience_id,
 * cutoff, MIN_RECEIVED. `created_at` is SQLite's `YYYY-MM-DD HH:MM:SS`, so it is
 * rewritten as ISO to compare with the rest.
 */
export const INACTIVE_IDS = `
  SELECT q.id FROM (
    SELECT c.id, MAX(COALESCE(c.last_engaged_at, ''), COALESCE(c.consent_at, ''),
                     strftime('%Y-%m-%dT%H:%M:%fZ', c.created_at), ?) AS quiet
      FROM contacts c
     WHERE c.audience_id = ? AND c.status = 'subscribed'
  ) q
  WHERE q.quiet <= ?
    AND (SELECT COUNT(*) FROM (SELECT 1 FROM deliveries d
          WHERE d.contact_id = q.id AND d.status = 'sent' AND d.sent_at > q.quiet LIMIT ${MIN_RECEIVED})) >= ?
    AND NOT EXISTS (SELECT 1 FROM deliveries d JOIN mails m ON m.id = d.mail_id
                     WHERE d.contact_id = q.id AND d.status NOT IN ('failed', 'skipped')
                       AND m.segment = 'inactive' AND m.sunset_done_at IS NULL)`;

/**
 * When engagement data starts: the moment delivery tracking was turned on.
 * Installs that turned it on before this column existed get the first
 * delivered event, which only arrives through the webhook. Null: tracking off.
 */
export async function trackingSince(trackingOn: boolean, nowMs = Date.now()): Promise<string | null> {
  if (!trackingOn) return null;
  const s = await get<{ tracking_since: string | null }>(`SELECT tracking_since FROM settings WHERE id = 1`);
  if (s?.tracking_since) return s.tracking_since;
  const first = await get<{ at: string | null }>(`SELECT MIN(delivered_at) AS at FROM deliveries`);
  const since = first?.at || iso(nowMs);
  await run(`UPDATE settings SET tracking_since = COALESCE(tracking_since, ?) WHERE id = 1`, [since]);
  return since;
}

/**
 * Opens and clicks recorded before `last_engaged_at` existed live only on the
 * delivery rows. Without copying them over, every past reader would look
 * inactive after an upgrade. One pass over deliveries, once per install (the
 * settings flag); idempotent if it is cut short and run again.
 */
export async function backfillEngagement(): Promise<void> {
  const s = await get<{ engagement_backfilled_at: string | null }>(`SELECT engagement_backfilled_at FROM settings WHERE id = 1`);
  if (s?.engagement_backfilled_at) return;
  await run(
    `UPDATE contacts SET last_engaged_at = e.at
       FROM (SELECT contact_id, MAX(MAX(COALESCE(opened_at, ''), COALESCE(clicked_at, ''))) AS at
               FROM deliveries WHERE opened_at IS NOT NULL OR clicked_at IS NOT NULL GROUP BY contact_id) e
      WHERE contacts.id = e.contact_id AND COALESCE(contacts.last_engaged_at, '') < e.at`,
  );
  await run(`UPDATE settings SET engagement_backfilled_at = ? WHERE id = 1`, [new Date().toISOString()]);
}

/** Record that tracking was turned on now, unless it already was. */
export async function markTrackingOn(nowMs = Date.now()): Promise<void> {
  await run(`UPDATE settings SET tracking_since = COALESCE(tracking_since, ?) WHERE id = 1`, [iso(nowMs)]);
}

export interface InactiveSummary {
  days: number;
  inactive: number;
  /** Asked already and inside the grace period. */
  asked: number;
  /** When the earliest finished ask removes whoever stayed silent; null while it is still sending. */
  removes_from: string | null;
  last_engagement_at: string | null;
  /** Why asking isn't allowed now; null when it is. */
  blocked: string | null;
}

/**
 * Why the engagement data can't be trusted to call anyone inactive, or null.
 * Checked when the ask is created and again when it is sent.
 */
export async function blockedReason(trackingOn: boolean, days: number, nowMs = Date.now()): Promise<string | null> {
  if (!trackingOn) {
    return "Turn on delivery tracking in Settings first. Without opens and clicks every subscriber would look inactive.";
  }
  // Until past opens and clicks are on the contacts, past readers look inactive.
  const s = await get<{ engagement_backfilled_at: string | null }>(`SELECT engagement_backfilled_at FROM settings WHERE id = 1`);
  if (!s?.engagement_backfilled_at) return "Reading past opens and clicks didn't finish. Reload in a minute and try again.";
  const cutoff = iso(nowMs - days * DAY);
  const recent = await query(
    `SELECT 1 FROM deliveries
      WHERE mail_id IN (SELECT id FROM mails WHERE sent_at >= ?)
        AND (opened_at IS NOT NULL OR clicked_at IS NOT NULL) LIMIT 1`,
    [cutoff],
  );
  if (recent.length === 0) {
    return `No open or click has been recorded in the last ${days} days. Check that open or click tracking is on for your sending domain in Resend.`;
  }
  return null;
}

export async function inactiveSummary(
  audienceId: string,
  trackingOn: boolean,
  days = INACTIVE_DAYS,
  nowMs = Date.now(),
): Promise<InactiveSummary> {
  const since = await trackingSince(trackingOn, nowMs);
  const blocked = await blockedReason(trackingOn, days, nowMs);
  const inactive = since
    ? await get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${INACTIVE_IDS})`, [since, audienceId, iso(nowMs - days * DAY), MIN_RECEIVED])
    : null;
  const asked = await get<{ n: number; first: string | null }>(
    `SELECT COUNT(*) AS n, MIN(m.sent_at) AS first
       FROM deliveries d JOIN mails m ON m.id = d.mail_id JOIN contacts c ON c.id = d.contact_id
      WHERE m.segment = 'inactive' AND m.sunset_done_at IS NULL AND m.audience_id = ?
        AND d.status = 'sent' AND c.status = 'subscribed'
        AND COALESCE(c.last_engaged_at, '') < d.sent_at AND COALESCE(c.consent_at, '') < d.sent_at`,
    [audienceId],
  );
  const last = await get<{ at: string | null }>(
    `SELECT MAX(MAX(COALESCE(opened_at, ''), COALESCE(clicked_at, ''))) AS at FROM deliveries
      WHERE mail_id IN (SELECT id FROM mails WHERE sent_at >= ?)`,
    [iso(nowMs - days * DAY)],
  );
  return {
    days,
    inactive: Number(inactive?.n ?? 0),
    asked: Number(asked?.n ?? 0),
    removes_from: asked?.first ? iso(Date.parse(asked.first) + GRACE_DAYS * DAY) : null,
    last_engagement_at: last?.at || null,
    blocked,
  };
}

/** A sign of life from this address: an open, a click, the keep link. Engagement is per person, on every list. */
export async function noteEngagement(email: string, at: string): Promise<void> {
  await run(
    `UPDATE contacts SET last_engaged_at = ? WHERE email = ? AND COALESCE(last_engaged_at, '') < ?`,
    [at, email.trim().toLowerCase(), at],
  );
}

/**
 * Stop mailing everyone an ask reached who stayed silent through the grace
 * period, once per ask. An ask is due GRACE_DAYS after its send ended
 * (`sent_at`; a send stopped by a fatal error has none, so its last edit
 * counts). Waiting for the end, not each copy's own time, delays removal by
 * at most the send's length and keeps the per-minute check to one indexed
 * lookup instead of a pass over the ask's deliveries.
 *
 * Idempotent: a person who engaged after their copy, or isn't subscribed any
 * more, is left alone, and a closed ask is never read again.
 */
export async function finishSunsets(nowMs = Date.now()): Promise<number> {
  const due = iso(nowMs - GRACE_DAYS * DAY);
  const asks = await query<{ id: number }>(
    `SELECT id FROM mails
      WHERE segment = 'inactive' AND sunset_done_at IS NULL AND status IN ('sent', 'failed')
        AND COALESCE(sent_at, strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)) <= ?`,
    [due],
  );
  let removed = 0;
  for (const ask of asks) {
    const rows = await query<{ id: string }>(
      `UPDATE contacts SET status = 'unsubscribed', unsubscribe_reason = 'inactive', unsubscribed_at = ?, confirm_token = NULL
        WHERE id IN (
          SELECT c.id FROM deliveries d JOIN contacts c ON c.id = d.contact_id
           WHERE d.mail_id = ? AND d.status = 'sent' AND d.sent_at <= ? AND c.status = 'subscribed'
             AND COALESCE(c.last_engaged_at, '') < d.sent_at AND COALESCE(c.consent_at, '') < d.sent_at)
        RETURNING id`,
      [iso(nowMs), ask.id, due],
    );
    removed += rows.length;
    await run(`UPDATE mails SET sunset_done_at = ? WHERE id = ? AND sunset_done_at IS NULL`, [iso(nowMs), ask.id]);
  }
  return removed;
}

/**
 * The keep link. Counts as engagement, and brings back someone the sunset
 * already removed: they just said yes. Never someone who unsubscribed or
 * bounced. A GET does this, unlike unsubscribe: a link scanner "keeping"
 * someone only means they are asked again next round.
 */
export async function keepSubscribed(contactId: string, nowMs = Date.now()): Promise<{ email: string } | null> {
  const row = await get<{ email: string; status: string; unsubscribe_reason: string | null }>(
    `SELECT email, status, unsubscribe_reason FROM contacts WHERE id = ?`,
    [contactId],
  );
  if (!row) return null;
  const at = iso(nowMs);
  if (row.status === "unsubscribed" && row.unsubscribe_reason === "inactive") {
    await run(
      `UPDATE contacts SET status = 'subscribed', unsubscribe_reason = NULL, unsubscribed_at = NULL
        WHERE id = ? AND status = 'unsubscribed' AND unsubscribe_reason = 'inactive'`,
      [contactId],
    );
  } else if (row.status !== "subscribed") {
    return null;
  }
  await noteEngagement(row.email, at);
  return { email: row.email };
}
