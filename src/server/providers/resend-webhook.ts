/**
 * Resend delivery events, verified and reduced to what this app acts on.
 *
 * Resend signs webhooks with Svix: HMAC-SHA256 over `${id}.${timestamp}.${body}`
 * keyed with the base64 part of the `whsec_…` secret, sent as a space-separated
 * list of `v1,<base64>` in `svix-signature`
 * (https://docs.svix.com/receiving/verifying-payloads/how-manual). WebCrypto
 * rather than the svix package: no dependency for twenty lines.
 */

export const RESEND_EVENTS = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
] as const;

/** The tag every newsletter message carries, so an event maps to its delivery row. */
export const DELIVERY_TAG = "delivery";

/** Replays older than this are refused, as Svix recommends. */
const TOLERANCE_SEC = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export async function verifyResendWebhook(
  raw: string,
  h: WebhookHeaders,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!h.id || !h.timestamp || !h.signature || !secret) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > TOLERANCE_SEC) return false;

  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (ch) => ch.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h.id}.${h.timestamp}.${raw}`)),
  );
  const expected = btoa(String.fromCharCode(...mac));

  return h.signature
    .split(" ")
    .map((part) => part.split(",", 2))
    .some(([version, sig]) => version === "v1" && !!sig && timingSafeEqual(sig, expected));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type DeliveryEvent =
  | { kind: "delivered"; deliveryId: string | null; messageId: string; at: string }
  | { kind: "bounced"; deliveryId: string | null; messageId: string; at: string; permanent: boolean; reason: string }
  | { kind: "complained"; deliveryId: string | null; messageId: string; at: string }
  | { kind: "opened"; deliveryId: string | null; messageId: string; at: string }
  | { kind: "clicked"; deliveryId: string | null; messageId: string; at: string };

/** Null for events this app doesn't act on (sent, delivery_delayed, …) and for anything malformed. */
export function parseResendEvent(body: unknown): DeliveryEvent | null {
  const e = body as {
    type?: string;
    created_at?: string;
    data?: {
      email_id?: string;
      tags?: Record<string, string> | { name: string; value: string }[];
      bounce?: { type?: string; message?: string };
    };
  };
  const messageId = e?.data?.email_id;
  if (!e?.type || !messageId) return null;
  const at = e.created_at || new Date().toISOString();
  const deliveryId = tagValue(e.data?.tags, DELIVERY_TAG);

  switch (e.type) {
    case "email.delivered":
      return { kind: "delivered", deliveryId, messageId, at };
    case "email.bounced": {
      // Resend documents `Permanent` and `Temporary`. Anything unrecognised is
      // treated as temporary: wrongly marking a good address bounced stops
      // mailing a real subscriber for good, the opposite error only costs one
      // more attempt.
      const permanent = e.data?.bounce?.type === "Permanent";
      return { kind: "bounced", deliveryId, messageId, at, permanent, reason: e.data?.bounce?.message || "" };
    }
    case "email.complained":
      return { kind: "complained", deliveryId, messageId, at };
    case "email.opened":
      return { kind: "opened", deliveryId, messageId, at };
    case "email.clicked":
      return { kind: "clicked", deliveryId, messageId, at };
    default:
      return null;
  }
}

/** Webhook payloads carry tags as an object; accept the send-time array shape too. */
function tagValue(tags: unknown, name: string): string | null {
  if (!tags) return null;
  if (Array.isArray(tags)) {
    const t = tags.find((x) => x && (x as { name?: string }).name === name) as { value?: string } | undefined;
    return t?.value ?? null;
  }
  const v = (tags as Record<string, unknown>)[name];
  return typeof v === "string" ? v : null;
}
