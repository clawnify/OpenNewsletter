import { useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Mail } from "../../shared/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function SendDialog({ mail, onClose, onSent }: { mail: Mail; onClose: () => void; onSent: (i: Mail) => void }) {
  const { status, settings, saveMail } = useStore();
  const [audienceId, setAudienceId] = useState(mail.audience_id || settings?.default_audience_id || "");
  const [testTo, setTestTo] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "send">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const connected = status?.resend_connected;
  const audiences = status?.audiences || [];

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
      const res = await api<{ mail: Mail }>("POST", `/api/mails/${mail.id}/send`, { scheduled_at: when || undefined, from });
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
              <Label>Schedule (optional)</Label>
              <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </div>
          </div>
        )}

        {err ? <p className="text-sm text-destructive">{err}</p> : null}
        {msg ? <p className="text-sm text-success">{msg}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {connected ? (
            <Button disabled={!audienceId || !fromReady || busy === "send"} onClick={send}>
              {busy === "send" ? "Sending…" : when ? "Schedule" : "Send now"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
