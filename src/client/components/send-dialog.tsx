import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, Copy } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Check, Mail } from "../../shared/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toLocalInput, whenLabel } from "../lib/status";

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function SendDialog({ mail, onClose, onSent }: { mail: Mail; onClose: () => void; onSent: (i: Mail) => void }) {
  const { status, settings, saveMail, refreshStatus } = useStore();
  const [audienceId, setAudienceId] = useState(mail.audience_id || settings?.default_audience_id || "");
  const [testTo, setTestTo] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "send">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const connected = status?.resend_connected;
  const audiences = status?.audiences || [];
  // Counts as of now, not as of when the app loaded.
  useEffect(() => { refreshStatus().catch(() => {}); }, [refreshStatus]);
  const audience = audiences.find((a) => a.id === audienceId);
  const confirmed = audience?.subscribed_count ?? 0;
  const pending = audience?.pending_count ?? 0;

  // From-addresses: the primary settings sender + any saved senders.
  const senders: { label: string; value: string }[] = [];
  if (settings?.from_email) {
    const v = settings.from_name ? `${settings.from_name} <${settings.from_email}>` : settings.from_email;
    senders.push({ label: v, value: v });
  }
  for (const s of settings?.senders || []) {
    const v = `${s.name} <${s.email}>`;
    if (!senders.some((x) => x.value === v)) senders.push({ label: v, value: v });
  }
  const [from, setFrom] = useState(senders[0]?.value || "");
  const fromReady = senders.length > 0 && !!from;

  // Re-run for each sender picked: domain and DMARC belong to the From address.
  const [checks, setChecks] = useState<Check[] | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    setChecks(null);
    api<{ checks: Check[] }>("GET", `/api/mails/${mail.id}/preflight${from ? `?from=${encodeURIComponent(from)}` : ""}`)
      .then((r) => live && setChecks(r.checks))
      .catch(() => live && setChecks([]));
    return () => { live = false; };
  }, [mail.id, from, connected]);

  const sendTest = async () => {
    setErr(null); setMsg(null); setBusy("test");
    try {
      await api("POST", `/api/mails/${mail.id}/test`, { to: testTo.trim(), from });
      setMsg(`Test sent to ${testTo.trim()}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const send = async () => {
    setErr(null); setMsg(null);
    if (!audienceId) return setErr("Pick an audience.");
    setBusy("send");
    try {
      if (mail.audience_id !== audienceId) await saveMail(mail.id, { audience_id: audienceId });
      // The input is wall-clock time in this browser's timezone; the server needs
      // the instant, so the offset goes with it.
      const scheduled_at = when ? new Date(when).toISOString() : undefined;
      const res = await api<{ mail: Mail }>("POST", `/api/mails/${mail.id}/send`, { scheduled_at, from });
      onSent(res.mail);
    } catch (e) {
      setErr((e as Error).message);
      setBusy("");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send “{mail.title}”</DialogTitle>
        </DialogHeader>

        {!connected ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            Connect Resend first — add <code>RESEND_API_KEY</code> in your Clawnify environment.
          </p>
        ) : (
          <div className="space-y-4">
            {!fromReady ? (
              <p className="rounded-sm bg-warning-tint p-3 text-sm text-warning">Add a sender in Settings before sending.</p>
            ) : (
              <div className="space-y-1.5">
                <Label>From</Label>
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger><SelectValue placeholder="Select sender…" /></SelectTrigger>
                  <SelectContent>
                    {senders.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Audience</Label>
              <Select value={audienceId} onValueChange={setAudienceId}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {audiences.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {audience ? (
                confirmed > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Goes to {confirmed.toLocaleString()} confirmed {confirmed === 1 ? "subscriber" : "subscribers"}.
                    {pending > 0 ? ` ${pending.toLocaleString()} still waiting to confirm won't get it.` : ""}
                  </p>
                ) : (
                  <p className="rounded-sm bg-warning-tint p-2 text-xs text-warning">
                    Nobody on this audience has confirmed yet{pending > 0 ? ` (${pending.toLocaleString()} waiting)` : ""}. You can schedule it; it goes to whoever has confirmed by then.
                  </p>
                )
              ) : null}
            </div>

            <Preflight checks={checks} />

            <div className="rounded-md p-3 shadow-edge">
              <Label className="mb-1.5 block">Send a test</Label>
              <div className="flex gap-2">
                <Input placeholder="you@example.com" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
                <Button variant="outline" disabled={!testTo.trim() || busy === "test"} onClick={sendTest}>
                  {busy === "test" ? "Sending…" : "Test"}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="send-when">Schedule (optional)</Label>
              <Input id="send-when" type="datetime-local" value={when} min={toLocalInput(new Date().toISOString())} onChange={(e) => setWhen(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                Your time ({TIMEZONE.replace(/_/g, " ")}).
                {mail.status === "scheduled" && mail.scheduled_at ? ` Now set for ${whenLabel(mail.scheduled_at)}: pick a new time, or send now.` : ""}
              </p>
            </div>
          </div>
        )}

        {err ? <p className="text-sm text-destructive">{err}</p> : null}
        {msg ? <p className="text-sm text-success">{msg}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {connected ? (
            <Button disabled={!audienceId || !fromReady || busy === "send" || (!when && !!audience && confirmed === 0 && (mail.status === "draft" || mail.status === "scheduled"))} onClick={send}>
              {busy === "send" ? "Sending…" : when ? "Schedule" : "Send now"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const ICON = {
  ok: <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Fine" />,
  warn: <AlertTriangle className="size-4 shrink-0 text-warning" aria-label="Worth fixing" />,
  fail: <XCircle className="size-4 shrink-0 text-destructive" aria-label="Blocks sending" />,
  unknown: <HelpCircle className="size-4 shrink-0 text-muted-foreground" aria-label="Couldn't check" />,
};

/** Deliverability advice. Never blocks the button: the send route refuses what can't go out. */
function Preflight({ checks }: { checks: Check[] | null }) {
  if (checks === null) return <p className="text-xs text-muted-foreground">Checking deliverability…</p>;
  if (!checks.length) return null;
  const issues = checks.filter((c) => c.level !== "ok").length;
  return (
    <div className="space-y-1.5">
      <Label>{issues ? `Before you send: ${issues} to look at` : "Before you send: all clear"}</Label>
      <ul className="space-y-2">
        {checks.map((c) => (
          <li key={c.id} className="flex gap-2 text-xs">
            <span className="mt-px">{ICON[c.level]}</span>
            <div className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{c.title}.</span>{" "}
              <span className="text-muted-foreground">{c.detail}</span>
              {c.record ? <DnsRecord {...c.record} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DnsRecord({ name, type, value }: { name: string; type: string; value: string }) {
  const [copied, setCopied] = useState("");
  const copy = (what: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => setCopied(what)).catch(() => {});
  };
  const row = (label: string, text: string) => (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-foreground">{text}</code>
      <button type="button" className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copy(label, text)}>
        {copied === label ? <CheckCircle2 className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
  return (
    <div className="mt-1.5 space-y-0.5 rounded-sm bg-muted p-2">
      {row("Name", name)}
      {row("Type", type)}
      {row("Value", value)}
    </div>
  );
}
