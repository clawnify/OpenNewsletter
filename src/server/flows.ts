/**
 * Automations (flows): a contact walks a small chain of steps once — send an
 * email, wait, send another. Welcome series, winback, anniversary.
 *
 * The one rule the whole design turns on, taken from the Klaviyo teardown
 * (~/wiki/OpenNewsletter/klaviyo-flows-teardown.md §11):
 *
 *   **The enrollment row is the truth; a queued job is only a wake-up call that
 *   re-checks the row.**
 *
 * This is forced by the same two facts `schedule.ts` is built around: the
 * platform queue is at-least-once (a wake can arrive twice) and a job cannot be
 * cancelled once enqueued (a wake for an old plan still fires). So nothing is
 * decided by a wake; a wake only asks "is this enrollment still due, and what
 * now?", and the row answers. Three things make that load-bearing:
 *
 *  - **Idempotent advance, recovered by redelivery (not a claim).** Each wake
 *    carries the `wake_seq` that was current when it was scheduled; a wake whose
 *    seq no longer matches the row no-ops (it was superseded). The advance does
 *    NOT consume the seq up front — it re-reads the row and acts, and `park`
 *    books the next wake BEFORE bumping the seq, throwing if the booking fails.
 *    So the enrollment is never bumped past a wake that was never enqueued: on a
 *    crash or a failed enqueue the HTTP handler answers non-2xx, the
 *    at-least-once queue redelivers the same (un-bumped) job, and the retry
 *    re-runs harmlessly. This is the stranding failure the design exists to
 *    avoid; there is no in-app sweep, because a Workers-for-Platforms app can't
 *    own a cron trigger.
 *  - **Send-once regardless.** An email step records a `flow_step_events` row
 *    under a unique index `(enrollment_id, step_id)` and sends under a stable
 *    provider idempotency key, so even two wakes that both act send one email
 *    and keep one record.
 *  - **Consent is re-checked at every send,** never snapshotted. An
 *    unsubscribed or bounced contact *exits* the flow with a reason rather than
 *    being skipped forward, so nobody who opted out sits "waiting".
 *
 * Why a delay is "consumed on arrival": when advancing onto a delay we DON'T
 * park the enrollment on the delay step — we set `current_step_id` to the step
 * *after* it and freeze `due_at = now + seconds`. So a waiter already points
 * past the delay. Editing that delay's duration never has to migrate anyone
 * (waiters keep their frozen `due_at`; only later arrivals read the new config),
 * and deleting it doesn't touch waiters at all. That is Klaviyo's entire
 * edit-a-live-flow contract (their §5 table) falling out of one data choice.
 *
 * Decoupled from the HTTP layer the way `sending.ts` is from the provider:
 * `scheduleWake` and `send` are injected, so the engine is tested against real
 * SQLite with a fake sender and no queue. See flows.test.ts.
 *
 * v1 scope (named so the gaps are decisions, not omissions): steps are
 * email / delay(duration) / end, chained linearly. Not yet built — multi-branch
 * splits (the schema's `kind` CHECK and this engine would both need `split`),
 * delay "at time of day" / weekday windows, per-contact timezones, frequency
 * capping across campaigns, `date_anniversary` / `api_event` triggers (schema
 * allows them; only `subscribed` enrolls here), and a back-populate of past
 * contacts. The canvas UI is a later change; this is the engine under it.
 */
import { query, get, run } from "./db";

const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "")}`;

/** Attempts at one email step (first try plus retries) before it's given up on. */
export const SEND_MAX_ATTEMPTS = 4;
/** Backoff before a retry, multiplied by the attempt number. */
export const SEND_RETRY_BACKOFF_SECONDS = 300;

// ── Types ─────────────────────────────────────────────────────────────────

export type FlowStatus = "draft" | "live" | "paused" | "archived";
export type TriggerType = "subscribed" | "date_anniversary" | "api_event";
export type Reentry = "none" | "always" | "after";
// 'split' is a reserved, not-yet-instantiable kind (see schema.sql): the engine
// exits an enrollment that somehow reaches one rather than mistreating it.
export type StepKind = "email" | "delay" | "split" | "end";

export interface Flow {
  id: string;
  name: string;
  status: FlowStatus;
  trigger_type: TriggerType;
  trigger_config: string;
  reentry: Reentry;
  reentry_after_seconds: number | null;
  entry_step_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowStep {
  id: string;
  flow_id: string;
  kind: StepKind;
  config: string;
  next_step_id: string | null;
  deleted_at: string | null;
  forward_to_step_id: string | null;
}

export interface EmailConfig {
  mail_id: number;
}
export interface DelayConfig {
  seconds: number;
}

/** Trigger filter for a `subscribed` flow. */
export interface SubscribedTrigger {
  /** Only this audience (list). Omit / null = any audience. */
  audience_id?: string | null;
  /**
   * Which consent sources enroll. Default excludes `import` and `crm_sync`:
   * a bulk import is not someone choosing to receive a welcome. A signup form
   * confirming (double opt-in) is the welcome case, so `signup_form` is in by
   * default; `manual` too (an operator adding one person they spoke to).
   */
  consent_sources?: string[];
}
const DEFAULT_CONSENT_SOURCES = ["signup_form", "manual"];

/** Merge-value snapshot carried for an enrollment's sends. */
export interface MergeSnapshot {
  first_name?: string;
  last_name?: string;
  email: string;
}

/**
 * What the engine needs from the outside world. Injected so the engine is
 * testable without the queue or a real email provider.
 */
export interface FlowDeps {
  /** ms clock; override in tests. */
  nowMs?: () => number;
  /**
   * Book a wake for this enrollment at `dueAt`, carrying `wakeSeq`. Returns
   * false when no scheduler is available (no queue / wrong host / enqueue
   * failed). A false return is NOT swallowed: `enrollOnSubscribed` deletes the
   * just-created row (no phantom waiter), and `park` throws so the queue
   * redelivers the current job to retry. (A Workers-for-Platforms app can't own
   * a cron trigger, so there is no in-app sweep to recover a dropped wake;
   * durable recovery of any still-stranded enrollment is a platform-side job.)
   */
  scheduleWake: (enrollmentId: string, wakeSeq: number, dueAt: string) => Promise<boolean>;
  /**
   * Send one flow email to one contact, deduplicated by `idempotencyKey`.
   * Either resolve `{ ok: false }` (bounded same-step retry, then give up) or
   * throw (propagates out of runWake, the HTTP handler answers non-2xx, and the
   * at-least-once queue redelivers the job). Both are safe: the stable key keeps
   * a recovered attempt from double-sending.
   *
   * `{ ok: false, skip: true }` means the email itself isn't ready (no subject,
   * no content): retrying can't fix that, so the step is recorded `skipped`
   * with the reason and the contact moves on. This is what makes adding an
   * email to a live automation safe: the new email is born empty, and people
   * reaching it pass it until it's written (Klaviyo skips a draft message the
   * same way).
   */
  send: (input: {
    mailId: number;
    contactId: string;
    contact: MergeSnapshot;
    idempotencyKey: string;
  }) => Promise<{ ok: true; id: string } | { ok: false; error: string; skip?: boolean }>;
}

// ── Pure helpers (no DB) ────────────────────────────────────────────────────

/** `due_at` for a delay, frozen at the moment of arrival. */
export function dueAtFor(seconds: number, arrivedAtMs: number): string {
  return new Date(arrivedAtMs + Math.max(0, seconds) * 1000).toISOString();
}

/**
 * Follow tombstones: given a step id, return the first live step reachable by
 * `forward_to_step_id` hops, or null if the chain dead-ends. Cycle-guarded.
 */
export function resolveLiveStep(byId: Map<string, FlowStep>, startId: string | null): FlowStep | null {
  let id = startId;
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) return null; // forwarding cycle (shouldn't happen); stop rather than loop
    seen.add(id);
    const step = byId.get(id);
    if (!step) return null;
    if (!step.deleted_at) return step;
    id = step.forward_to_step_id;
  }
  return null;
}

/**
 * Whether a contact may (re)enter given the re-entry rule and when their last
 * journey through this flow ended. `none` = once ever; `always` = every time
 * (subject only to the one-live-journey unique index); `after` = only once
 * N seconds have passed since the last one ended.
 */
export function reentryAllows(
  reentry: Reentry,
  afterSeconds: number | null,
  priorEndedAtMs: number | null,
  nowMs: number,
): boolean {
  if (priorEndedAtMs === null) return true; // never enrolled before
  if (reentry === "none") return false;
  if (reentry === "always") return true;
  return nowMs - priorEndedAtMs >= (afterSeconds ?? 0) * 1000;
}

// ── Reads ─────────────────────────────────────────────────────────────────

const FLOW_COLS =
  "id, name, status, trigger_type, trigger_config, reentry, reentry_after_seconds, entry_step_id, created_at, updated_at";

export async function getFlow(id: string): Promise<Flow | null> {
  return (await get(`SELECT ${FLOW_COLS} FROM flows WHERE id = ?`, [id])) as Flow | null;
}

export async function stepsOf(flowId: string): Promise<FlowStep[]> {
  return (await query(
    `SELECT id, flow_id, kind, config, next_step_id, deleted_at, forward_to_step_id
       FROM flow_steps WHERE flow_id = ?`,
    [flowId],
  )) as unknown as FlowStep[];
}

export interface FlowSummary extends Flow {
  waiting: number;
  completed: number;
  exited: number;
}

export async function listFlows(): Promise<FlowSummary[]> {
  const flows = (await query(`SELECT ${FLOW_COLS} FROM flows ORDER BY created_at DESC`)) as unknown as Flow[];
  const out: FlowSummary[] = [];
  for (const f of flows) {
    const c = (await get(
      `SELECT
         SUM(state = 'waiting')   AS waiting,
         SUM(state = 'completed') AS completed,
         SUM(state = 'exited')    AS exited
       FROM flow_enrollments WHERE flow_id = ?`,
      [f.id],
    )) as { waiting: number | null; completed: number | null; exited: number | null } | null;
    out.push({ ...f, waiting: Number(c?.waiting ?? 0), completed: Number(c?.completed ?? 0), exited: Number(c?.exited ?? 0) });
  }
  return out;
}

/** Per-step counts for the detail canvas: how many sent, were skipped/failed, and are waiting here now. */
export interface StepStat {
  sent: number;
  skipped: number;
  waiting: number;
}
export async function stepStats(flowId: string): Promise<Record<string, StepStat>> {
  const out: Record<string, StepStat> = {};
  const bump = (id: string): StepStat => (out[id] ??= { sent: 0, skipped: 0, waiting: 0 });
  const events = (await query(
    `SELECT ev.step_id AS step_id, ev.outcome AS outcome, COUNT(*) AS n
       FROM flow_step_events ev JOIN flow_enrollments e ON e.id = ev.enrollment_id
      WHERE e.flow_id = ? GROUP BY ev.step_id, ev.outcome`,
    [flowId],
  )) as unknown as { step_id: string; outcome: string; n: number }[];
  for (const r of events) {
    if (!r.step_id) continue;
    const s = bump(r.step_id);
    if (r.outcome === "sent") s.sent += Number(r.n);
    else if (r.outcome === "skipped" || r.outcome === "failed") s.skipped += Number(r.n);
  }
  const waiting = (await query(
    `SELECT current_step_id AS step_id, COUNT(*) AS n FROM flow_enrollments
      WHERE flow_id = ? AND state = 'waiting' GROUP BY current_step_id`,
    [flowId],
  )) as unknown as { step_id: string; n: number }[];
  for (const r of waiting) if (r.step_id) bump(r.step_id).waiting += Number(r.n);
  return out;
}

/** Whether anyone has ever entered this flow (the trigger's list is fixed from then on). */
export async function hasEnrollments(flowId: string): Promise<boolean> {
  return !!(await get(`SELECT 1 AS x FROM flow_enrollments WHERE flow_id = ? LIMIT 1`, [flowId]));
}

/** Point a `subscribed` flow at another list, keeping its other trigger settings. */
export async function setTriggerAudience(flowId: string, audienceId: string): Promise<void> {
  const flow = await getFlow(flowId);
  if (!flow) return;
  const trig = parseConfig<SubscribedTrigger>(flow.trigger_config) ?? {};
  await run(`UPDATE flows SET trigger_config = ?, updated_at = ? WHERE id = ?`, [
    JSON.stringify({ ...trig, audience_id: audienceId }),
    now(),
    flowId,
  ]);
}

export async function renameFlow(flowId: string, name: string): Promise<void> {
  await run(`UPDATE flows SET name = ?, updated_at = ? WHERE id = ?`, [name, now(), flowId]);
}

// ── Authoring primitives (create / edit a flow) ─────────────────────────────

export async function createFlow(spec: {
  name: string;
  trigger_type: TriggerType;
  trigger_config?: object;
  reentry?: Reentry;
  reentry_after_seconds?: number | null;
}): Promise<Flow> {
  const id = uid("flow");
  await run(
    `INSERT INTO flows (id, name, trigger_type, trigger_config, reentry, reentry_after_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      spec.name,
      spec.trigger_type,
      JSON.stringify(spec.trigger_config ?? {}),
      spec.reentry ?? "none",
      spec.reentry_after_seconds ?? null,
    ],
  );
  return (await getFlow(id))!;
}

export async function addStep(flowId: string, kind: StepKind, config: object = {}): Promise<FlowStep> {
  const id = uid("step");
  await run(`INSERT INTO flow_steps (id, flow_id, kind, config) VALUES (?, ?, ?, ?)`, [
    id,
    flowId,
    kind,
    JSON.stringify(config),
  ]);
  return (await get(
    `SELECT id, flow_id, kind, config, next_step_id, deleted_at, forward_to_step_id FROM flow_steps WHERE id = ?`,
    [id],
  )) as FlowStep;
}

export async function setNext(stepId: string, nextStepId: string | null): Promise<void> {
  await run(`UPDATE flow_steps SET next_step_id = ?, updated_at = ? WHERE id = ?`, [nextStepId, now(), stepId]);
}

export async function setEntry(flowId: string, stepId: string): Promise<void> {
  await run(`UPDATE flows SET entry_step_id = ?, updated_at = ? WHERE id = ?`, [stepId, now(), flowId]);
}

/** Edit a step's config. For a delay this changes only later arrivals; waiters keep their frozen `due_at`. */
export async function editStepConfig(stepId: string, config: object): Promise<void> {
  await run(`UPDATE flow_steps SET config = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(config), now(), stepId]);
}

/**
 * Delete a step: tombstone it, point its `forward_to_step_id` at what came
 * next, and relink any predecessor onto that same target. Waiters already
 * parked past a delay are unaffected; a waiter pointing AT this step follows
 * the forward link on its next wake (see resolveLiveStep). Never hard-deleted.
 */
export async function deleteStep(flowId: string, stepId: string): Promise<void> {
  const step = (await get(`SELECT next_step_id FROM flow_steps WHERE id = ? AND flow_id = ?`, [stepId, flowId])) as {
    next_step_id: string | null;
  } | null;
  if (!step) return;
  const forward = step.next_step_id;
  await run(`UPDATE flow_steps SET deleted_at = ?, forward_to_step_id = ?, updated_at = ? WHERE id = ?`, [
    now(),
    forward,
    now(),
    stepId,
  ]);
  await run(`UPDATE flow_steps SET next_step_id = ? WHERE flow_id = ? AND next_step_id = ?`, [forward, flowId, stepId]);
  // If this was the entry, move entry forward too.
  await run(`UPDATE flows SET entry_step_id = ? WHERE id = ? AND entry_step_id = ?`, [forward, flowId, stepId]);
}

/**
 * Insert an email or a wait into the chain, after `afterStepId` (null = first,
 * right after the trigger). Allowed on a live flow; the rule for people
 * already in it is Klaviyo's (teardown §5): **nobody's send time moves, and a
 * new email ahead of someone is one they get.**
 *
 * Because a delay is consumed on arrival, a waiter points at the step *after*
 * its wait (`Q` below). An email inserted right before `Q` is ahead of them,
 * so they are moved onto it, keeping `due_at` and `wake_seq`: their existing
 * wake fires at the same moment and runs the new email, then `Q`. Waiters
 * pointing at a deleted step that forwards to `Q` are the same people. Anyone
 * who already attempted `Q` (a send retry parks on `Q` itself) has passed this
 * point and stays put. A new *wait* moves nobody: it would push back a time
 * already promised. Either way no wake is booked or bumped here, so this can't
 * strand anyone; a wake in progress that reads the row before this write just
 * carries on past the new step, which is the "already passed" case.
 */
export async function insertStep(
  flowId: string,
  afterStepId: string | null,
  kind: "email" | "delay",
  config: object,
): Promise<FlowStep> {
  const flow = await getFlow(flowId);
  if (!flow) throw new Error("Flow not found.");
  const steps = await stepsOf(flowId);
  const byId = new Map(steps.map((s) => [s.id, s]));
  let next: string | null;
  if (afterStepId === null) {
    next = resolveLiveStep(byId, flow.entry_step_id)?.id ?? null;
  } else {
    const after = byId.get(afterStepId);
    if (!after || after.deleted_at || after.kind === "end") throw new Error("Can't add a step there.");
    next = resolveLiveStep(byId, after.next_step_id)?.id ?? null;
  }

  const step = await addStep(flowId, kind, config);
  await setNext(step.id, next);
  if (afterStepId === null) await setEntry(flowId, step.id);
  else await setNext(afterStepId, step.id);

  if (kind === "email" && next) {
    const targets = [next, ...steps.filter((s) => s.deleted_at && resolveLiveStep(byId, s.id)?.id === next).map((s) => s.id)];
    await run(
      `UPDATE flow_enrollments SET current_step_id = ?, updated_at = ?
         WHERE flow_id = ? AND state = 'waiting'
           AND current_step_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM flow_step_events ev
                            WHERE ev.enrollment_id = flow_enrollments.id AND ev.step_id = ?)`,
      [step.id, now(), flowId, JSON.stringify(targets), next],
    );
  }
  return (await get(
    `SELECT id, flow_id, kind, config, next_step_id, deleted_at, forward_to_step_id FROM flow_steps WHERE id = ?`,
    [step.id],
  )) as FlowStep;
}

/** Live email steps and the flow each belongs to, keyed by mail id. */
export async function flowEmails(): Promise<Map<number, { id: string; name: string }>> {
  const rows = (await query(
    `SELECT json_extract(s.config, '$.mail_id') AS mail_id, f.id AS id, f.name AS name
       FROM flow_steps s JOIN flows f ON f.id = s.flow_id
      WHERE s.kind = 'email' AND s.deleted_at IS NULL`,
  )) as unknown as { mail_id: number | null; id: string; name: string }[];
  const out = new Map<number, { id: string; name: string }>();
  for (const r of rows) if (r.mail_id != null) out.set(Number(r.mail_id), { id: r.id, name: r.name });
  return out;
}

// ── Validation (what "turn on" refuses) ─────────────────────────────────────

export interface FlowIssue {
  step_id?: string;
  message: string;
}

/**
 * What would silently misbehave if this flow went live. `emailReady` is
 * supplied by the caller (it knows what a sendable mail is: subject + body +
 * a configured sender); the engine checks only structure.
 */
export async function validateFlow(
  flowId: string,
  emailReady: (mailId: number) => Promise<string | null>,
): Promise<FlowIssue[]> {
  const flow = await getFlow(flowId);
  if (!flow) return [{ message: "Flow not found." }];
  const steps = await stepsOf(flowId);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const issues: FlowIssue[] = [];

  const entry = resolveLiveStep(byId, flow.entry_step_id);
  if (!entry) issues.push({ message: "This automation has no first step." });

  // Walk every live step once: every email must be sendable, and every path
  // must reach an End — a delay (or email) with nothing live after it would
  // strand waiters, so it's a turn-on error, never a silent exit.
  const seen = new Set<string>();
  let emails = 0;
  const walk = async (startId: string | null) => {
    let s = resolveLiveStep(byId, startId);
    while (s && !seen.has(s.id)) {
      seen.add(s.id);
      if (s.kind === "end") return;
      if (s.kind === "email") {
        emails++;
        const cfg = parseConfig<EmailConfig>(s.config);
        const why = cfg?.mail_id ? await emailReady(cfg.mail_id) : "Email step has no newsletter attached.";
        if (why) issues.push({ step_id: s.id, message: why });
      }
      const next = resolveLiveStep(byId, s.next_step_id);
      if (!next) {
        issues.push({ step_id: s.id, message: "This step has nothing after it. End the path with an End step." });
        return;
      }
      s = next;
    }
  };
  if (entry) await walk(entry.id);
  if (entry && emails === 0) issues.push({ message: "Add an email before turning this on." });
  return issues;
}

// ── Status changes (turn on / pause / resume / archive) ─────────────────────

export async function setFlowStatus(flowId: string, status: FlowStatus, deps: FlowDeps): Promise<void> {
  const flow = await getFlow(flowId);
  if (!flow) return;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();

  if (status === "archived") {
    // Every waiter exits; their outstanding wakes will find state != 'waiting'.
    await run(
      `UPDATE flow_enrollments SET state = 'exited', exit_reason = 'flow_archived', updated_at = ?
         WHERE flow_id = ? AND state = 'waiting'`,
      [now(), flowId],
    );
  }
  await run(`UPDATE flows SET status = ?, updated_at = ? WHERE id = ?`, [status, now(), flowId]);

  if (status === "live" && flow.status === "paused") {
    // Resume: re-book a wake for everyone whose due time has passed while
    // paused. We carry each enrollment's CURRENT wake_seq, so the re-booked wake
    // matches the row; a lingering pre-pause wake carries the same seq and the
    // advance is idempotent, so they can't double-fire. Future-due waiters still
    // have their original wake outstanding.
    const due = (await query(
      `SELECT id, wake_seq, due_at FROM flow_enrollments
         WHERE flow_id = ? AND state = 'waiting' AND due_at <= ?`,
      [flowId, new Date(nowMs).toISOString()],
    )) as unknown as { id: string; wake_seq: number; due_at: string }[];
    for (const e of due) await deps.scheduleWake(e.id, e.wake_seq, e.due_at);
  }
}

// ── Enrollment ──────────────────────────────────────────────────────────────

/**
 * A contact just became `subscribed`. Enroll them into every live `subscribed`
 * flow whose trigger accepts this audience and consent source, respecting
 * re-entry. Best-effort relative to the consent transition: a scheduling or
 * write failure here must never fail the confirm the caller already completed,
 * so the caller runs this after responding / in a try-catch.
 */
export async function enrollOnSubscribed(
  contact: { id: string; audience_id: string; email: string; first_name?: string; last_name?: string; consent_source: string },
  deps: FlowDeps,
): Promise<string[]> {
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const flows = (await query(
    `SELECT ${FLOW_COLS} FROM flows WHERE status = 'live' AND trigger_type = 'subscribed'`,
  )) as unknown as Flow[];

  const enrolled: string[] = [];
  for (const flow of flows) {
    const trig = parseConfig<SubscribedTrigger>(flow.trigger_config) ?? {};
    if (trig.audience_id && trig.audience_id !== contact.audience_id) continue;
    const allowed = trig.consent_sources ?? DEFAULT_CONSENT_SOURCES;
    if (!allowed.includes(contact.consent_source)) continue;

    // Re-entry: look at the most recent prior journey for this (flow, contact).
    const prior = (await get(
      `SELECT state, updated_at FROM flow_enrollments
         WHERE flow_id = ? AND contact_id = ? ORDER BY entered_at DESC LIMIT 1`,
      [flow.id, contact.id],
    )) as { state: string; updated_at: string } | null;
    if (prior?.state === "waiting") continue; // already live in this flow
    const priorEndedMs = prior ? Date.parse(prior.updated_at) : null;
    if (!reentryAllows(flow.reentry, flow.reentry_after_seconds, priorEndedMs, nowMs)) continue;

    const steps = await stepsOf(flow.id);
    const entry = resolveLiveStep(new Map(steps.map((s) => [s.id, s])), flow.entry_step_id);
    if (!entry) continue; // misconfigured; validateFlow blocks turn-on, but guard anyway

    const id = uid("enr");
    const payload = JSON.stringify({
      first_name: contact.first_name ?? "",
      last_name: contact.last_name ?? "",
      email: contact.email,
    } satisfies MergeSnapshot);
    try {
      // The unique index idx_enroll_active makes a concurrent double-enroll
      // (two confirms racing) insert once; the second throws and is skipped.
      await run(
        `INSERT INTO flow_enrollments (id, flow_id, contact_id, state, current_step_id, due_at, wake_seq, trigger_payload)
         VALUES (?, ?, ?, 'waiting', ?, ?, 0, ?)`,
        [id, flow.id, contact.id, entry.id, new Date(nowMs).toISOString(), payload],
      );
    } catch {
      continue; // already enrolled (unique index)
    }
    // Book the first wake. If it can't be booked (no managed queue, or a
    // transient enqueue failure), DELETE the row we just wrote rather than leave
    // a phantom `waiting` enrollment: with no sweep in a Workers-for-Platforms
    // app to recover it (dispatch-namespace workers can't own a cron trigger),
    // the row would otherwise block re-enrollment forever under the
    // idx_enroll_active unique index. The welcome just doesn't start this time;
    // on a deployed app the queue is present and this is a rare transient.
    const booked = await deps.scheduleWake(id, 0, new Date(nowMs).toISOString());
    if (!booked) {
      await run(`DELETE FROM flow_enrollments WHERE id = ?`, [id]);
      continue;
    }
    enrolled.push(id);
  }
  return enrolled;
}

// ── The wake: advance one enrollment ────────────────────────────────────────

export type WakeResult =
  | { acted: false; reason: string }
  | { acted: true; sent: number; state: "waiting" | "completed" | "exited" };

interface EnrollmentRow {
  id: string;
  flow_id: string;
  contact_id: string;
  state: string;
  current_step_id: string;
  due_at: string;
  wake_seq: number;
  trigger_payload: string;
}

/**
 * Process the wake carrying (`enrollmentId`, `wakeSeq`). Returns a non-acting
 * result (which the HTTP caller answers 2xx to, so the queue marks the job
 * done) when the wake is stale, superseded, the flow isn't live, or it isn't
 * due yet. Otherwise it advances the enrollment as far as it can in one go:
 * sends due emails (guarded), consumes delays (parks with a fresh wake), and
 * completes or exits.
 */
export async function runWake(enrollmentId: string, wakeSeq: number, deps: FlowDeps): Promise<WakeResult> {
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const enr = (await get(
    `SELECT id, flow_id, contact_id, state, current_step_id, due_at, wake_seq, trigger_payload
       FROM flow_enrollments WHERE id = ?`,
    [enrollmentId],
  )) as EnrollmentRow | null;
  if (!enr) return { acted: false, reason: "no-enrollment" };
  if (enr.state !== "waiting") return { acted: false, reason: "not-waiting" };
  if (enr.wake_seq !== wakeSeq) return { acted: false, reason: "superseded" };

  const flow = await getFlow(enr.flow_id);
  if (!flow) return { acted: false, reason: "no-flow" };
  if (flow.status === "archived") {
    await exit(enr.id, "flow_archived");
    return { acted: true, sent: 0, state: "exited" };
  }
  if (flow.status !== "live") return { acted: false, reason: `flow-${flow.status}` }; // paused/draft: wait

  if (Date.parse(enr.due_at) > nowMs) {
    // Fired early (clock skew, or the platform delivering before runAt). THIS
    // delivery was the current-seq wake, and the HTTP caller answers 2xx, so if
    // we just returned there would be no wake left for the real due time. Re-book
    // one (same position, same due) under a fresh seq so it is never lost.
    await park(enr, enr.current_step_id, enr.due_at, deps);
    return { acted: false, reason: "not-due" };
  }

  // NB: no claim/compare-and-set here. Crash-safety comes from at-least-once
  // redelivery, not from consuming the seq up front: `park` books the next wake
  // BEFORE it bumps wake_seq, and throws if the booking fails, so the queue
  // redelivers THIS same (un-bumped) job to retry rather than stranding the
  // enrollment. The advance below is idempotent (sends are guarded by the
  // unique index + provider key; position writes are deterministic), so a
  // redelivered same-seq wake re-runs harmlessly and a superseded one no-ops at
  // the wake_seq check above.
  const steps = await stepsOf(enr.flow_id);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const merge = parseConfig<MergeSnapshot>(enr.trigger_payload) ?? { email: "" };
  let currentId: string | null = enr.current_step_id;
  let sent = 0;

  // Advance until we hit a delay (park), the end (complete), an exit, or a
  // dead end (complete defensively). Each email is send-once guarded.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = resolveLiveStep(byId, currentId);
    if (!step || step.kind === "end") {
      await complete(enr.id);
      return { acted: true, sent, state: "completed" };
    }

    if (step.kind === "email") {
      const already = await alreadySent(enr.id, step.id);
      if (!already) {
        // Consent is state, re-checked now. Unsubscribed/bounced exit here.
        const contact = (await get(`SELECT status, first_name, last_name, email FROM contacts WHERE id = ?`, [
          enr.contact_id,
        ])) as { status: string; first_name: string; last_name: string; email: string } | null;
        if (!contact) {
          await exit(enr.id, "contact_deleted");
          return { acted: true, sent, state: "exited" };
        }
        if (contact.status !== "subscribed") {
          await exit(enr.id, contact.status === "bounced" ? "bounced" : "unsubscribed");
          return { acted: true, sent, state: "exited" };
        }
        const cfg = parseConfig<EmailConfig>(step.config);
        if (cfg?.mail_id) {
          // Prefer the contact's current name/email for the send; fall back to
          // the enrollment snapshot. Consent already confirmed above.
          const to: MergeSnapshot = { first_name: contact.first_name, last_name: contact.last_name, email: contact.email || merge.email };
          // One stable key across every attempt at this step, so a retry after
          // a lost response dedupes at the provider instead of mailing twice.
          const res = await deps.send({ mailId: cfg.mail_id, contactId: enr.contact_id, contact: to, idempotencyKey: `flow-${enr.id}-${step.id}` });
          if (!res.ok && res.skip) {
            await recordEvent(enr.id, step.id, "skipped", res.error.slice(0, 300));
          } else if (!res.ok) {
            // A send that failed is not skipped forward (that silently loses an
            // email on a transient blip): re-park on THIS step and retry with
            // backoff, up to a cap, then give up and record 'failed'. The same
            // idempotency key keeps a recovered attempt from double-sending.
            const tries = await countEvents(enr.id, step.id, "retry");
            if (tries + 1 < SEND_MAX_ATTEMPTS) {
              await recordEvent(enr.id, step.id, "retry", res.error.slice(0, 300));
              await park(enr, step.id, dueAtFor(SEND_RETRY_BACKOFF_SECONDS * (tries + 1), nowMs), deps);
              return { acted: true, sent, state: "waiting" };
            }
            await recordEvent(enr.id, step.id, "failed", res.error.slice(0, 300));
            // fall through: give up on this one email and continue the flow
          } else {
            await recordSent(enr.id, step.id, res.id);
            sent++;
          }
        }
      }
      currentId = step.next_step_id;
      continue;
    }

    // Any step kind the engine doesn't yet act on (a `split`, reserved in the
    // schema for forward-compatibility) must not be silently mistaken for a
    // delay: exit with a named reason rather than send on a wrong schedule.
    if (step.kind !== "delay") {
      await exit(enr.id, "unsupported_step");
      return { acted: true, sent, state: "exited" };
    }

    // delay: consume on arrival. Freeze due_at on the step AFTER the delay and
    // park the enrollment there. Editing this delay later never moves anyone
    // already parked.
    const delay = parseConfig<DelayConfig>(step.config);
    const next = resolveLiveStep(byId, step.next_step_id);
    if (!next || next.kind === "end") {
      await complete(enr.id);
      return { acted: true, sent, state: "completed" };
    }
    await park(enr, next.id, dueAtFor(delay?.seconds ?? 0, nowMs), deps);
    return { acted: true, sent, state: "waiting" };
  }
}

/**
 * Move an enrollment to `stepId`, due at `dueAt`, and book the wake for it.
 *
 * Booking happens BEFORE the wake_seq bump, and a failed booking throws: the
 * caller's HTTP handler then answers non-2xx, the at-least-once queue redelivers
 * the same job (its payload seq still matches the un-bumped row), and the retry
 * re-books. So a wake is never bumped-away without a replacement enqueued — the
 * stranding failure the enrollment-is-truth design is meant to avoid. The new
 * wake carries `enr.wake_seq + 1`; any older wake for this enrollment then
 * no-ops at the superseded check.
 */
async function park(enr: EnrollmentRow, stepId: string, dueAt: string, deps: FlowDeps): Promise<void> {
  const nextSeq = enr.wake_seq + 1;
  const booked = await deps.scheduleWake(enr.id, nextSeq, dueAt);
  if (!booked) throw new Error(`flow: could not book wake for enrollment ${enr.id}`);
  await run(`UPDATE flow_enrollments SET current_step_id = ?, due_at = ?, wake_seq = ?, updated_at = ? WHERE id = ?`, [
    stepId,
    dueAt,
    nextSeq,
    now(),
    enr.id,
  ]);
}

// ── small DB helpers ─────────────────────────────────────────────────────────

function parseConfig<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

async function alreadySent(enrollmentId: string, stepId: string): Promise<boolean> {
  const row = await get(
    `SELECT 1 AS x FROM flow_step_events WHERE enrollment_id = ? AND step_id = ? AND outcome = 'sent' LIMIT 1`,
    [enrollmentId, stepId],
  );
  return !!row;
}

async function countEvents(enrollmentId: string, stepId: string, outcome: string): Promise<number> {
  const row = (await get(
    `SELECT COUNT(*) AS n FROM flow_step_events WHERE enrollment_id = ? AND step_id = ? AND outcome = ?`,
    [enrollmentId, stepId, outcome],
  )) as { n: number } | null;
  return Number(row?.n ?? 0);
}

async function recordSent(enrollmentId: string, stepId: string, providerId: string): Promise<void> {
  try {
    await run(`INSERT INTO flow_step_events (enrollment_id, step_id, outcome, detail) VALUES (?, ?, 'sent', ?)`, [
      enrollmentId,
      stepId,
      providerId,
    ]);
  } catch {
    // Unique index idx_step_sent_once: another wake already recorded this send.
  }
}

async function recordEvent(enrollmentId: string, stepId: string, outcome: string, detail: string): Promise<void> {
  await run(`INSERT INTO flow_step_events (enrollment_id, step_id, outcome, detail) VALUES (?, ?, ?, ?)`, [
    enrollmentId,
    stepId,
    outcome,
    detail,
  ]);
}

async function complete(enrollmentId: string): Promise<void> {
  await run(`UPDATE flow_enrollments SET state = 'completed', updated_at = ? WHERE id = ?`, [now(), enrollmentId]);
}

async function exit(enrollmentId: string, reason: string): Promise<void> {
  await run(`UPDATE flow_enrollments SET state = 'exited', exit_reason = ?, updated_at = ? WHERE id = ?`, [
    reason,
    now(),
    enrollmentId,
  ]);
  await recordEvent(enrollmentId, "", "exited", reason);
}

/** Mirrors schema.sql, for installs whose database predates these tables. */
export const FLOWS_DDL = [
  `CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','paused','archived')),
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('subscribed','date_anniversary','api_event')),
    trigger_config TEXT NOT NULL DEFAULT '{}',
    reentry TEXT NOT NULL DEFAULT 'none' CHECK (reentry IN ('none','always','after')),
    reentry_after_seconds INTEGER,
    entry_step_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS flow_steps (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('email','delay','split','end')),
    config TEXT NOT NULL DEFAULT '{}',
    next_step_id TEXT,
    deleted_at TEXT,
    forward_to_step_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_flow_steps_flow ON flow_steps(flow_id)`,
  `CREATE TABLE IF NOT EXISTS flow_enrollments (
    id TEXT PRIMARY KEY,
    flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('waiting','completed','exited')),
    current_step_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    wake_seq INTEGER NOT NULL DEFAULT 0,
    trigger_payload TEXT NOT NULL DEFAULT '{}',
    exit_reason TEXT,
    entered_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_enroll_active ON flow_enrollments(flow_id, contact_id) WHERE state = 'waiting'`,
  `CREATE INDEX IF NOT EXISTS idx_enroll_due ON flow_enrollments(state, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_enroll_step ON flow_enrollments(current_step_id, state)`,
  `CREATE TABLE IF NOT EXISTS flow_step_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    enrollment_id TEXT NOT NULL REFERENCES flow_enrollments(id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_step_sent_once ON flow_step_events(enrollment_id, step_id) WHERE outcome = 'sent'`,
];
