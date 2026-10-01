/**
 * What a delivery event changes: the delivery row it belongs to, and for a
 * hard bounce or a complaint, the person.
 *
 * Every write is idempotent (first timestamp wins, status moves only
 * forward), because providers deliver webhooks at least once and retry on any
 * non-2xx.
 */
import { get, run } from "./db";
import type { DeliveryEvent } from "./providers/resend-webhook";

export type EventOutcome = "applied" | "unknown-delivery";

export async function applyDeliveryEvent(ev: DeliveryEvent): Promise<EventOutcome> {
  // The tag is the reliable key; the provider id is the fallback for messages
  // sent before tagging existed.
  const d = ev.deliveryId
    ? await get<{ id: string; email: string }>(`SELECT id, email FROM deliveries WHERE id = ?`, [ev.deliveryId])
    : await get<{ id: string; email: string }>(`SELECT id, email FROM deliveries WHERE provider_message_id = ?`, [
        ev.messageId,
      ]);
  if (!d) return "unknown-delivery";

  switch (ev.kind) {
    case "delivered":
      await run(`UPDATE deliveries SET delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`, [ev.at, d.id]);
      break;
    case "opened":
      await run(`UPDATE deliveries SET opened_at = COALESCE(opened_at, ?) WHERE id = ?`, [ev.at, d.id]);
      break;
    case "clicked":
      await run(`UPDATE deliveries SET clicked_at = COALESCE(clicked_at, ?) WHERE id = ?`, [ev.at, d.id]);
      break;
    case "bounced":
      await run(
        `UPDATE deliveries SET bounced_at = COALESCE(bounced_at, ?), bounce_reason = ?,
                bounce_permanent = MAX(bounce_permanent, ?)
          WHERE id = ?`,
        [ev.at, ev.reason.slice(0, 500), ev.permanent ? 1 : 0, d.id],
      );
      // A hard bounce is a fact about the address, so it holds on every list
      // here. A soft bounce (full mailbox, greylisting) is not: the address
      // stays subscribed and the next issue tries again.
      if (ev.permanent) {
        await run(
          `UPDATE contacts SET status = 'bounced', confirm_token = NULL
            WHERE email = ? AND status IN ('subscribed', 'pending')`,
          [d.email],
        );
      }
      break;
    case "complained":
      // Marking an issue as spam is the strongest unsubscribe there is, and
      // mailing that person again is what gets a sending domain blocked. It
      // covers every list this publication runs, not only the one mailed.
      await run(`UPDATE deliveries SET complained_at = COALESCE(complained_at, ?) WHERE id = ?`, [ev.at, d.id]);
      await run(
        `UPDATE contacts SET status = 'unsubscribed', unsubscribed_at = COALESCE(unsubscribed_at, ?), confirm_token = NULL
          WHERE email = ? AND status <> 'unsubscribed'`,
        [ev.at, d.email],
      );
      break;
  }
  return "applied";
}
