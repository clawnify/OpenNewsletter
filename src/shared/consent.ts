/**
 * Consent evidence — the sentence that turns a row in a file into a subscriber.
 *
 * Every import path in the app (CRM, CSV, manual add) needs the same answer to
 * "is this real evidence, or is it the word 'ok'?". Sharing it means the rule
 * is one rule, and the message an operator sees is the same wherever they meet
 * it — a list that accepts "ok" is a list that cannot be defended later.
 */

/**
 * Minimum length of a real sentence. Short strings like "ok", "yes" or "-" are
 * exactly the non-evidence that makes an import indefensible, and a length check
 * is the cheapest thing that reliably rejects them.
 */
export const MIN_EVIDENCE_LENGTH = 12;

export const EVIDENCE_REQUIRED_MESSAGE =
  "Say how these people agreed to hear from you (at least a short sentence). Without it they stay pending and receive nothing.";

/** Returns the trimmed evidence, or null when it is too thin to be evidence. */
export function validateEvidence(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  return t.length >= MIN_EVIDENCE_LENGTH ? t : null;
}
