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

export interface SendResult {
  id: string;
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  html: string;
}

/**
 * One recipient of a bulk send, carrying its own rendered body.
 *
 * Per-recipient rather than one shared body because the unsubscribe link in
 * the footer has to identify *this* subscriber — a shared link would let
 * whoever clicks it unsubscribe everyone on the list.
 */
export interface BulkRecipient {
  email: string;
  html: string;
  /**
   * This subscriber's unsubscribe URL. Already embedded in `html`; passed
   * separately so a provider that has to add the List-Unsubscribe header
   * itself doesn't have to scrape it back out of the markup.
   */
  unsubscribeUrl: string;
}

export interface SendBulkInput {
  from: string;
  subject: string;
  recipients: BulkRecipient[];
  /**
   * Stable identifier for the list being mailed — the audience id. Scopes
   * unsubscribes, so it must never change for a given list: a new key silently
   * detaches every prior opt-out and starts mailing people who left.
   */
  listKey: string;
}

export interface SendBulkResult {
  sent: string[];
  /** Recipients the backend refused because they had already unsubscribed. */
  suppressed: string[];
  failed: { email: string; error: string }[];
}

export interface EmailProvider {
  /** Provider id, e.g. "resend". */
  readonly name: string;
  /** Verified sending domains on the account (status: "verified", …). */
  listDomains(): Promise<{ name: string; status: string }[]>;
  /** Send a one-off email (used for "send test"). */
  sendEmail(input: SendEmailInput): Promise<SendResult>;
  /** Send one message per recipient. */
  sendBulk(input: SendBulkInput): Promise<SendBulkResult>;
}
