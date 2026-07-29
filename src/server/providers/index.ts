/**
 * Provider registry. Resolves the active EmailProvider.
 *
 * Order is deliberate — an explicitly configured key is a choice the operator
 * made, so it wins over the managed default:
 *
 *   1. RESEND_API_KEY            — bring your own key (also how local dev runs)
 *   2. the org's Resend connection (Settings → Integrations)
 *   3. CLAWNIFY_TOKEN            — managed sending, no setup, the default for
 *                                  anyone who hasn't connected anything
 *
 * Managed sending last rather than first means existing installs keep sending
 * through the account they already warmed up, instead of silently moving to a
 * different sending domain on deploy.
 *
 * To add a provider, implement EmailProvider and add a branch here.
 */
import { connect, type ConnectionsEnv } from "@clawnify/connections";
import type { EmailProvider } from "./types";
import { ResendProvider } from "./resend";
import { ClawnifyProvider } from "./clawnify";

export type { EmailProvider } from "./types";
export type { BulkRecipient, SendBulkResult } from "./types";

export async function getEmailProvider(env: ConnectionsEnv): Promise<EmailProvider | null> {
  const own = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
  if (typeof own === "string" && own) return new ResendProvider(own);

  const resendToken = await connect("resend", env).token();
  if (resendToken) return new ResendProvider(resendToken);

  const clawnify = (env as { CLAWNIFY_TOKEN?: string }).CLAWNIFY_TOKEN;
  if (typeof clawnify === "string" && clawnify) return new ClawnifyProvider(clawnify);

  return null;
}
