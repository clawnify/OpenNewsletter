import { useState } from "react";
import { api } from "../api";
import type { Mail } from "../../shared/types";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// An automation's email goes to each person when they reach its step, so the
// only send it offers is a test to yourself. The full send dialog (list,
// schedule) would mail everyone, which the server refuses for these anyway.
export function TestSendDialog({ mail, onClose }: { mail: Mail; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setErr(null); setMsg(null); setBusy(true);
    try {
      await api("POST", `/api/mails/${mail.id}/test`, { to: to.trim() });
      setMsg(`Test sent to ${to.trim()}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test</DialogTitle>
          <DialogDescription>
            “{mail.title || "Untitled email"}” is part of the automation “{mail.flow?.name}”. It goes to each subscriber when they reach its step.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (to.trim()) void send(); }}>
          <Label htmlFor="test-to">Send to</Label>
          <Input id="test-to" type="email" autoFocus placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
        </form>
        {err ? <p className="text-sm text-destructive">{err}</p> : null}
        {msg ? <p className="text-sm text-success">{msg}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button disabled={!to.trim() || busy} onClick={send}>{busy ? "Sending…" : "Send test"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
