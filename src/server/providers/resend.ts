/**
 * Resend adapter for the EmailProvider interface.
 *
 * Transactional sends only (`POST /emails`), one message per recipient —
 * *not* Broadcasts. Broadcasts require the subscriber list to live in a Resend
 * account, which is exactly what moving contacts into D1 undid. The trade is
 * that Resend's hosted unsubscribe page comes with Broadcasts, so on this path
 * the app owns unsubscribe entirely: its own footer link, its own List-
 * Unsubscribe header, its own suppression check before sending.
 *
 * REST (fetch) rather than the `resend` SDK: no dependency, and the raw API is
 * a better fit for a Worker.
 */
import type {
  EmailProvider,
  SendBulkInput,
  SendBulkResult,
  SendEmailInput,
  SendResult,
} from "./types";

const BASE = "https://api.resend.com";

// Resend's default rate ceiling is modest; keep concurrency conservative so a
// large send degrades into slowness rather than a wall of 429s.
const CONCURRENCY = 4;

export class ResendProvider implements EmailProvider {
  readonly name = "resend";
  readonly managesUnsubscribes = false;

  constructor(private apiKey: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
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
    const r = await this.req<{ id: string }>("POST", "/emails", {
      from: input.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
    });
    return { id: r.id };
  }

  async sendBulk(input: SendBulkInput): Promise<SendBulkResult> {
    const out: SendBulkResult = { sent: [], suppressed: [], failed: [] };

    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= input.recipients.length) return;
        const r = input.recipients[i];
        try {
          await this.req("POST", "/emails", {
            from: input.from,
            to: [r.email],
            subject: input.subject,
            html: r.html,
            // Gmail/Yahoo/Microsoft require these of bulk senders. On this path
            // nothing upstream adds them, so the app's own unsubscribe URL —
            // already embedded in the footer — is reused as the one-click
            // target. It accepts POST for exactly this reason.
            headers: {
              "List-Unsubscribe": `<${r.unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          });
          out.sent.push(r.email);
        } catch (e: any) {
          out.failed.push({ email: r.email, error: e?.message || "send failed" });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, input.recipients.length) }, worker),
    );
    return out;
  }
}
