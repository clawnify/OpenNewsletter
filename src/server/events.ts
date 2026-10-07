/**
 * What a delivery event changes: the delivery row it belongs to, and for a
 * hard bounce or a complaint, the person.
 *
 * Every write is idempotent (first timestamp wins, status moves only
 * forward), because providers deliver webhooks at least once and retry on any
 * non-2xx.
 */
import { get, run } from "./db";
import { noteEngagement } from "./sunset";
import type { DeliveryEvent } from "./providers/resend-webhook";

export type EventOutcome = "applied" | "suppressed-no-delivery" | "engaged-no-delivery" | "unknown-delivery";

/**
 * Suppress a contact by address, the same way on every list this publication
 * runs. A hard bounce is a fact about the address; a complaint is the strongest
 * unsubscribe there is, and mailing that person again is what gets a sending
 * domain blocked. Idempotent: status only moves forward.
 */
async function suppressByEmail(email: string, ev: DeliveryEvent): Promise<void> {
  if (ev.kind === "bounced" && ev.permanent) {
    await run(
      `UPDATE contacts SET status = 'bounced', confirm_token = NULL WHERE email = ? AND status IN ('subscribed', 'pending')`,
      [email],
    );
  } else if (ev.kind === "complained") {
    await run(
      `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?), confirm_token = NULL,
              unsubscribe_reason = NULL
        WHERE email = ? AND (status <> 'unsubscribed' OR unsubscribe_reason IS NOT NULL)`,
      [ev.at, email],
    );
  }
}

export async function applyDeliveryEvent(ev: DeliveryEvent): Promise<EventOutcome> {
  // The tag is the reliable key; the provider id is the fallback for messages
  // sent before tagging existed.
  const d = ev.deliveryId
    ? await get<{ id: string; email: string }>(`SELECT id, email FROM deliveries WHERE id = ?`, [ev.deliveryId])
    : await get<{ id: string; email: string }>(`SELECT id, email FROM deliveries WHERE provider_message_id = ?`, [
        ev.messageId,
      ]);
  if (!d) {
    // No delivery row: a flow email (which sends without one), or a message
    // predating tracking. Per-message open/click stats need a row and are lost,
    // but consent safety must not be — so a hard bounce or a complaint still
    // suppresses the contact, keyed on the address the provider reported. A soft
    // bounce has nothing to do without a row, so it stays "unknown-delivery".
    const suppresses = (ev.kind === "bounced" && ev.permanent) || ev.kind === "complained";
    const to = ev.kind === "bounced" || ev.kind === "complained" ? ev.to : null;
    if (suppresses && to) {
      await suppressByEmail(to, ev);
      return "suppressed-no-delivery";
    }
    // A welcome-flow email read is a reader, for the sunset as for any issue.
    if ((ev.kind === "opened" || ev.kind === "clicked") && ev.to) {
      await noteEngagement(ev.to, ev.at);
      return "engaged-no-delivery";
    }
    return "unknown-delivery";
  }

  switch (ev.kind) {
    case "delivered":
      await run(`UPDATE deliveries SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`, [ev.at, d.id]);
      break;
    case "opened":
      await run(`UPDATE deliveries SET opened_at = COALESCE(opened_at, ?) WHERE id = ?`, [ev.at, d.id]);
      await noteEngagement(d.email, ev.at);
      break;
    case "clicked":
      await run(`UPDATE deliveries SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?`, [ev.at, d.id]);
      await noteEngagement(d.email, ev.at);
      break;
    case "bounced":
      await run(
        `UPDATE deliveries SET bounced_at = COALESCE(bounced_at, ?), bounce_reason = ?,
                bounce_permanent = MAX(bounce_permanent, ?)
          WHERE id = ?`,
        [ev.at, ev.reason.slice(0, 500), ev.permanent ? 1 : 0, d.id],
      );
      // A hard bounce holds on every list here; a soft bounce (full mailbox,
      // greylisting) does not — the address stays subscribed and the next issue
      // tries again. suppressByEmail applies only on a permanent bounce.
      await suppressByEmail(d.email, ev);
      break;
    case "complained":
      await run(`UPDATE deliveries SET complained_at = COALESCE(complained_at, ?) WHERE id = ?`, [ev.at, d.id]);
      await suppressByEmail(d.email, ev);
      break;
  }
  return "applied";
}
