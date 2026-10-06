/**
 * Email-provider abstraction. The app talks to this interface; a concrete
 * provider maps it to a vendor API.
 *
 * Deliberately **send-only**. It used to carry audiences, contacts and
 * broadcasts, which locked the app to providers that host subscriber lists and
 * left the publication's own list sitting in a third-party account. Contacts
 * now live in D1 (see ../contacts.ts), so a provider's only job is delivery —
 * which is what makes the backend genuinely swappable.
 */

import type { ProviderDomain } from "../preflight";

export interface SendResult {
  id: string;
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/** One message of a batch: its own body, because the footer's unsubscribe link identifies this recipient. */
export interface BatchMessage {
  to: string;
  html: string;
  /** Already embedded in `html`; passed separately for the List-Unsubscribe header. */
  unsubscribeUrl: string;
  /** Tagged on the message so delivery events map back to this row. */
  deliveryId?: string;
  /** This recipient's subject, when merge tags make it differ from the batch's. */
  subject?: string;
}

export interface SendBatchInput {
  from: string;
  subject: string;
  messages: BatchMessage[];
  /**
   * Same key for every attempt at this batch. A retry after a timeout must not
   * mail the batch twice, and only the provider can know whether the first
   * attempt landed. Stable across attempts, unique across batches and installs.
   */
  idempotencyKey: string;
}

/**
 * What happened to a batch. The kinds exist because the send loop has to act
 * differently on each, and "an error" collapses the one distinction that
 * matters: whether anything may have been delivered.
 */
export type BatchOutcome =
  /** Accepted. `ids[i]` is the provider's message id for `messages[i]`. */
  | { kind: "sent"; ids: string[] }
  /** Throttled; nothing sent. Retry the same batch after the wait. */
  | { kind: "rate_limited"; retryAfterMs: number }
  /** Rejected as a whole for one bad message; nothing sent. Send one by one to isolate it. */
  | { kind: "invalid"; message: string }
  /** Rejected for a reason no retry fixes (bad key, unverified domain); nothing sent. Stop the send. */
  | { kind: "fatal"; message: string }
  /** Another attempt with the same key is still in flight. Leave the batch to it. */
  | { kind: "in_progress" }
  /** No answer we can trust (timeout, 5xx). It may have been sent: retry later with the same key. */
  | { kind: "unknown"; message: string };

export interface EmailProvider {
  /** Provider id, e.g. "resend". */
  readonly name: string;
  /** Sending domains on the account (status: "verified", …). */
  listDomains(): Promise<ProviderDomain[]>;
  /** One domain's DNS records and whether each is verified. Optional: only for the preflight's detail. */
  domainRecords?(id: string): Promise<{ record: string; status: string }[]>;
  /** Send a one-off email (test sends, confirmations, isolating a bad message). Throws on failure. */
  sendEmail(input: SendEmailInput): Promise<SendResult>;
  /** Send up to BATCH_SIZE messages in one call. Never throws; see BatchOutcome. */
  sendBatch(input: SendBatchInput): Promise<BatchOutcome>;
  /**
   * Register (or find) this app's delivery-event webhook on the provider
   * account and return its signing secret. Optional: a provider without an
   * API for it is set up by hand. Throws WebhookSetupError when the key isn't
   * allowed to manage webhooks.
   */
  ensureWebhook?(endpoint: string): Promise<{ id: string; secret: string }>;
}

/** The key can send but not manage webhooks (e.g. a sending-only key). */
export class WebhookSetupError extends Error {}
