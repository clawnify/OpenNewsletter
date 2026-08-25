/**
 * Provider registry. Resolves the active EmailProvider.
 *
 * Order is deliberate — an explicitly configured key wins over the connection,
 * so local dev and a bring-your-own-key setup keep working:
 *
 *   1. RESEND_API_KEY              — your own key (also how local dev runs)
 *   2. the org's Resend connection (Settings → Integrations)
 *
 * Returns null when neither is present, so callers surface "no sending backend
 * is configured" rather than failing mid-send. Sending is the only thing a
 * provider does — audiences and contacts live in D1 (see ../contacts.ts), which
 * is what keeps this swappable.
 *
 * To add a provider, implement EmailProvider and add a branch here.
 */
import { connect, type ConnectionsEnv } from "@clawnify/connections";
import type { EmailProvider } from "./types";
import { ResendProvider } from "./resend";

export type { EmailProvider } from "./types";
export type { BulkRecipient, SendBulkResult } from "./types";

export async function getEmailProvider(env: ConnectionsEnv): Promise<EmailProvider | null> {
  const own = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
  if (typeof own === "string" && own) return new ResendProvider(own);

  const resendToken = await connect("resend", env).token();
  if (resendToken) return new ResendProvider(resendToken);

  return null;
}
