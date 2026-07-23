/**
 * Provider registry. Resolves the active EmailProvider from the org's
 * Resend connection (Settings → Integrations, via @clawnify/connections)
 * or a RESEND_API_KEY env var — the env var wins so local dev and BYO
 * keys keep working. To add a provider, implement EmailProvider and add
 * a branch here.
 */
import { connect, type ConnectionsEnv } from "@clawnify/connections";
import type { EmailProvider } from "./types";
import { ResendProvider } from "./resend";

export type { EmailProvider } from "./types";

export async function getEmailProvider(env: ConnectionsEnv): Promise<EmailProvider | null> {
  const own = env.RESEND_API_KEY;
  if (typeof own === "string" && own) return new ResendProvider(own);
  const token = await connect("resend", env).token();
  return token ? new ResendProvider(token) : null;
}
