import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Mail } from "../../shared/types";
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
