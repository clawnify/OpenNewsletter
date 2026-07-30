// Whether a queued send is still the one the operator wants.
//
// The queue is a *trigger*, not the source of truth. A job that fires is asking
// "should this still go out?" and only the mails row can answer — it may have
// been rescheduled, pulled back to draft, or already sent since the job was
// created. Three things make that question load-bearing rather than academic:
//
//  1. **Delivery is at-least-once by design.** The platform's reaper resets any
//     job orphaned in 'queued' back to 'pending' and re-dispatches it, so a send
//     that completed but whose outcome was never recorded WILL arrive twice.
//     Without a check here that means the entire subscriber list gets the same
//     newsletter twice — a reputation event, not a cosmetic bug.
//  2. **Rescheduling cannot cancel the old job.** The platform's idempotency
//     index is (org_id, idempotency_key) with no status predicate, and a
//     canceled row keeps its key until retention sweeps it, so the old job
//     stays live and fires at the original time.
//  3. Scheduling is the one action here whose blast radius is everybody at once.
//
// Kept pure and separate so it can be tested without a mail backend — the one
// piece of this app that decides whether thousands of people get an email.

export type SendVerdict =
  | { send: true }
  | { send: false; reason: "already-sent" | "not-scheduled" | "superseded" };

export interface ScheduledMailState {
  status: string;
  scheduled_at: string | null;
}

/**
 * `scheduledFor` is the timestamp the *job* was created to fire at, carried in
 * its payload. It is compared against what the mail says now.
 *
 * **null means "don't compare the time"** — for jobs enqueued before the payload
 * carried the field, which are still in flight across the deploy that adds it.
 * They keep the status guards (an already-sent issue is still refused) and skip
 * only the check they cannot answer. The alternative readings are both wrong:
 * treating absence as a mismatch silently drops a send the operator scheduled,
 * and skipping the whole verdict leaves that cohort with no duplicate
 * protection at all.
 *
 * A false verdict is a normal outcome, not an error: the caller must answer 2xx
 * so the platform marks the job done. A non-2xx would retry with backoff and
 * eventually record a failure for a job that did exactly the right thing.
 */
export function sendVerdict(mail: ScheduledMailState, scheduledFor: string | null): SendVerdict {
  // Checked first and separately from the timestamp compare: sending clears
  // scheduled_at, so a redelivery would also fail the compare — but "we already
  // sent this" is the fact worth reporting, and the one that must hold even if
  // the clearing behaviour ever changes.
  if (mail.status === "sent") return { send: false, reason: "already-sent" };

  // Pulled back to draft, or cancelled. The operator's intent changed.
  if (mail.status !== "scheduled") return { send: false, reason: "not-scheduled" };

  // Rescheduled. This job belongs to the old time; the job for the new time is
  // a different row and will fire on its own.
  if (scheduledFor !== null && mail.scheduled_at !== scheduledFor) {
    return { send: false, reason: "superseded" };
  }

  return { send: true };
}
