import { useEffect, useState } from "react";
import { api } from "../api";
import type { Mail } from "../../shared/types";
import { statusTone } from "../lib/status";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Stats {
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
  open: number;
  delivered: number;
  opened: number;
  clicked: number;
  hard_bounced: number;
  soft_bounced: number;
  complained: number;
  tracking: boolean;
}

const pct = (n: number, of: number) => (of > 0 ? ` (${Math.round((n / of) * 100)}%)` : "");

/** The status badge of a mail that has been sent (or tried), opening what happened to it. */
export function DeliveryStats({ mail }: { mail: Mail }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api<Stats>("GET", `/api/mails/${mail.id}/stats`).then(setStats).catch((e: Error) => setError(e.message));
  }, [open, mail.id, mail.status]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1.5 text-xs font-medium capitalize ${statusTone(mail.status)}`}
          aria-label={`${mail.status}: show delivery results`}
        >
          {mail.status}
          <ChevronDown size={12} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 text-sm">
        {error ? <p className="text-destructive">{error}</p> : null}
        {!stats && !error ? <p className="text-muted-foreground">Loading…</p> : null}
        {stats ? (
          <>
            {mail.send_error ? (
              <div className="space-y-1 rounded-sm bg-destructive-tint p-2 text-destructive">
                <p>{mail.send_error}</p>
                {mail.status === "failed" ? (
                  <p className="text-xs">Fix this, then press Send. Only people who haven't had it yet will get it.</p>
                ) : null}
              </div>
            ) : null}
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5">
              <Row label="Sent" value={`${stats.sent} of ${stats.recipients}`} />
              {stats.open > 0 ? <Row label="Still sending" value={stats.open} /> : null}
              {stats.failed > 0 ? <Row label="Failed" value={stats.failed} tone="text-destructive" /> : null}
              {stats.skipped > 0 ? <Row label="Unsubscribed before sending" value={stats.skipped} /> : null}
              {stats.tracking && stats.sent > 0 ? (
                <>
                  <Row label="Delivered" value={`${stats.delivered}${pct(stats.delivered, stats.sent)}`} />
                  <Row label="Clicked" value={`${stats.clicked}${pct(stats.clicked, stats.delivered || stats.sent)}`} />
                  <Row label="Opened*" value={`${stats.opened}${pct(stats.opened, stats.delivered || stats.sent)}`} />
                  <Row label="Bounced" value={stats.hard_bounced + stats.soft_bounced} tone={stats.hard_bounced ? "text-warning" : undefined} />
                  <Row label="Marked as spam" value={stats.complained} tone={stats.complained ? "text-destructive" : undefined} />
                </>
              ) : null}
            </dl>
            {stats.sent === 0 ? null : stats.tracking ? (
              <p className="text-xs text-muted-foreground">
                *Apple Mail opens every message on arrival, so opens run high. Clicks are the number to trust.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Turn on delivery tracking in Settings to see deliveries, clicks and bounces.
              </p>
            )}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right font-medium tabular-nums ${tone ?? ""}`}>{value}</dd>
    </>
  );
}
