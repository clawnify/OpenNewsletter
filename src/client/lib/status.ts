import type { Mail } from "../../shared/types";

/** Badge colours for a mail's status, shared by every list and the editor header. */
export function statusTone(status: Mail["status"]): string {
  switch (status) {
    case "sent":
      return "bg-success-tint text-success";
    case "scheduled":
    case "sending":
      return "bg-info-tint text-info";
    case "failed":
      return "bg-destructive-tint text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

/** "Tue 7 Oct, 14:00" in the viewer's own timezone. */
export function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** An instant as a datetime-local input value ("2026-10-07T14:00"), in the viewer's timezone. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * A scheduled issue whose time is well past has not gone out: its job kept
 * failing (an outage longer than the queue's retries) or never arrived.
 */
export function isLate(mail: { status: string; scheduled_at: string | null }, nowMs = Date.now()): boolean {
  return mail.status === "scheduled" && !!mail.scheduled_at && Date.parse(mail.scheduled_at) < nowMs - 15 * 60_000;
}
