/**
 * Which provider domains can send, shared by the send route, the preflight
 * and Settings' sender picker so they never disagree.
 *
 * Resend's statuses (https://resend.com/docs/dashboard/domains/introduction):
 * `partially_verified` can send (one of two sending records verified, or
 * receiving still pending), and `not_started`, `pending` and `failed` can't.
 * Anything else is left to Resend to accept or refuse at send time.
 */
const CANNOT_SEND = new Set(["not_started", "pending", "failed"]);

export function sendableStatus(status: string): boolean {
  return !CANNOT_SEND.has(status.toLowerCase());
}

/** The provider domain that signs mail from `fromDomain`: the exact name, else the closest parent. */
export function signingDomain<T extends { name: string }>(fromDomain: string, domains: T[]): T | null {
  const from = fromDomain.toLowerCase();
  let best: T | null = null;
  for (const d of domains) {
    const name = d.name.toLowerCase();
    if ((from === name || from.endsWith(`.${name}`)) && (!best || name.length > best.name.length)) best = d;
  }
  return best;
}
