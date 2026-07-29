/**
 * Clawnify managed-sending adapter.
 *
 * Sends through services.clawnify.com/email, authenticated with the org's
 * CLAWNIFY_TOKEN (injected into every deployed app at build time). The platform
 * owns the verified sending domain, per-org reputation isolation, and the
 * suppression ledger — it refuses recipients who unsubscribed, so opt-outs are
 * enforced below the app rather than relying on the app to remember.
 *
 * Requires the org's token to carry the `email` scope; without it every call
 * returns 403 `scope_required`, which is surfaced verbatim so the operator
 * knows to grant it rather than seeing a generic failure.
 */
import type {
  EmailProvider,
  SendBulkInput,
  SendBulkResult,
  SendEmailInput,
  SendResult,
} from "./types";

const BASE = "https://services.clawnify.com/email";

// The platform sends one message per recipient internally; this bounds how many
// of those we have in flight from a single Worker invocation.
const CONCURRENCY = 6;

interface SendResponse {
  sent?: { email: string; message_id: string | null }[];
  suppressed?: string[];
  failed?: { email: string; error: string }[];
}

export class ClawnifyProvider implements EmailProvider {
  readonly name = "clawnify";
  readonly managesUnsubscribes = true;

  constructor(private token: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
    }
    if (!res.ok) {
      const detail = json?.detail || json?.error || text || `HTTP ${res.status}`;
      throw new Error(`Clawnify email ${method} ${path} → ${res.status}: ${detail}`);
    }
    return json as T;
  }

  async listDomains(): Promise<{ name: string; status: string }[]> {
    const data = await this.req<{ domains?: { domain: string; status: string }[] }>(
      "GET",
      "/domains",
    );
    return (data.domains || []).map((d) => ({ name: d.domain, status: d.status }));
  }

  async sendEmail(input: SendEmailInput): Promise<SendResult> {
    const r = await this.req<SendResponse>("POST", "/send", {
      from: input.from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
    });
    const first = r.sent?.[0];
    if (!first) {
      const err = r.failed?.[0]?.error ?? (r.suppressed?.length ? "recipient unsubscribed" : "not sent");
      throw new Error(err);
    }
    return { id: first.message_id ?? "" };
  }

  async sendBulk(input: SendBulkInput): Promise<SendBulkResult> {
    const out: SendBulkResult = { sent: [], suppressed: [], failed: [] };

    // One call per recipient because each carries its own rendered body (the
    // footer's unsubscribe link is per-subscriber). The platform still applies
    // suppression and List-Unsubscribe on each.
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= input.recipients.length) return;
        const r = input.recipients[i];
        try {
          const res = await this.req<SendResponse>("POST", "/send", {
            from: input.from,
            to: [r.email],
            subject: input.subject,
            html: r.html,
            list_key: input.listKey,
          });
          if (res.sent?.length) out.sent.push(r.email);
          else if (res.suppressed?.length) out.suppressed.push(r.email);
          else out.failed.push({ email: r.email, error: res.failed?.[0]?.error ?? "not sent" });
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
