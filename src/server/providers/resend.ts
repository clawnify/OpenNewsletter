/**
 * Resend adapter for the EmailProvider interface.
 *
 * Per-recipient messages (`POST /emails/batch`, 100 at a time), *not*
 * Broadcasts. Broadcasts require the subscriber list to live in a Resend
 * account, which is exactly what moving contacts into D1 undid. The trade is
 * that Resend's hosted unsubscribe page comes with Broadcasts, so on this path
 * the app owns unsubscribe entirely: its own footer link, its own List-
 * Unsubscribe header, its own suppression check before sending.
 *
 * REST (fetch) rather than the `resend` SDK: no dependency, and the raw API is
 * a better fit for a Worker.
 */
import type {
  BatchOutcome,
  EmailProvider,
  SendBatchInput,
  SendEmailInput,
  SendResult,
} from "./types";

import { DELIVERY_TAG } from "./resend-webhook";

const BASE = "https://api.resend.com";

/** Gmail/Yahoo/Microsoft require these of bulk senders; nothing upstream adds them on this path. */
function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

export class ResendProvider implements EmailProvider {
  readonly name = "resend";

  constructor(private apiKey: string) {}

  private async req<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: this.headers(idempotencyKey),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
    }
    if (!res.ok) {
      const msg = json?.message || json?.error?.message || text || `HTTP ${res.status}`;
      throw new Error(`Resend ${method} ${path} → ${res.status}: ${msg}`);
    }
    return json as T;
  }

  async listDomains(): Promise<{ name: string; status: string }[]> {
    const data = await this.req<{ data?: Array<{ name: string; status: string }> }>(
      "GET",
      "/domains",
    );
    return (data.data || []).map((d) => ({ name: d.name, status: d.status }));
  }

  async sendEmail(input: SendEmailInput): Promise<SendResult> {
    const r = await this.req<{ id: string }>(
      "POST",
      "/emails",
      { from: input.from, to: [input.to], subject: input.subject, html: input.html, headers: input.headers },
      input.idempotencyKey,
    );
    return { id: r.id };
  }

  /**
   * POST /emails/batch: up to 100 messages, all-or-nothing validation, and an
   * Idempotency-Key that makes a retry of the same batch a no-op for 24 hours.
   * Error names from https://resend.com/docs/api-reference/errors.
   */
  async sendBatch(input: SendBatchInput): Promise<BatchOutcome> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/emails/batch`, {
        method: "POST",
        headers: this.headers(input.idempotencyKey),
        body: JSON.stringify(
          input.messages.map((m) => ({
            from: input.from,
            to: [m.to],
            subject: input.subject,
            html: m.html,
            headers: unsubscribeHeaders(m.unsubscribeUrl),
            // Echoed back on every webhook event for this message.
            ...(m.deliveryId ? { tags: [{ name: DELIVERY_TAG, value: m.deliveryId }] } : {}),
          })),
        ),
      });
    } catch (e: any) {
      return { kind: "unknown", message: e?.message || "network error" };
    }
    const json = (await res.json().catch(() => undefined)) as
      | { data?: { id: string }[]; name?: string; message?: string }
      | undefined;
    const message = `Resend ${res.status}: ${json?.message || res.statusText}`;

    if (res.ok) return { kind: "sent", ids: (json?.data || []).map((d) => d.id) };
    if (res.status === 429) {
      // Quota errors share the status with throttling, but waiting a second fixes only throttling.
      if (json?.name !== "rate_limit_exceeded") return { kind: "fatal", message };
      const secs = Number(res.headers.get("retry-after") || res.headers.get("ratelimit-reset") || "1");
      return { kind: "rate_limited", retryAfterMs: Math.max(1, Number.isFinite(secs) ? secs : 1) * 1000 };
    }
    if (res.status === 409) {
      return json?.name === "concurrent_idempotent_requests" ? { kind: "in_progress" } : { kind: "unknown", message };
    }
    // 401/403: the key or the sending domain, the same for every message.
    if (res.status === 401 || res.status === 403) return { kind: "fatal", message };
    if (res.status === 400 || res.status === 422) return { kind: "invalid", message };
    return { kind: "unknown", message };
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    };
  }
}
