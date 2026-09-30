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
