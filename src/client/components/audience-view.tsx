import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, Database, Send } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ResendAudience, ResendContact } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CrmImportDialog } from "./crm-import-dialog";

export function AudienceView() {
  const { status, setError, refreshStatus } = useStore();
  const audiences = status?.audiences || [];
  const [selected, setSelected] = useState<string>("");
  const [contacts, setContacts] = useState<ResendContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [crmOpen, setCrmOpen] = useState(false);

  useEffect(() => {
    if (!selected && audiences.length) setSelected(audiences[0].id);
  }, [audiences, selected]);

  const load = async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      setContacts(await api<ResendContact[]>("GET", `/api/audiences/${id}/contacts`));
    } catch (e) {
      setError((e as Error).message);
      setContacts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selected) load(selected);
  }, [selected]);

  const current = audiences.find((a: ResendAudience) => a.id === selected);

  const add = async () => {
    if (!email.trim()) return;
    try {
      const c = await api<ResendContact>("POST", `/api/audiences/${selected}/contacts`, { email: email.trim(), first_name: first.trim() || undefined });
      setContacts((p) => [c, ...p]);
      setEmail("");
      setFirst("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const [sendingConfirmations, setSendingConfirmations] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const sendConfirmations = async () => {
    setSendingConfirmations(true);
    setConfirmMsg(null);
    try {
      const r = await api<{ sent: number; failed: number }>("POST", `/api/audiences/${selected}/confirmations`);
      setConfirmMsg(
        r.sent === 0 && r.failed === 0
          ? "Nobody is owed a confirmation email right now."
          : `Sent ${r.sent} confirmation email${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSendingConfirmations(false);
      await Promise.all([load(selected), refreshStatus()]);
    }
  };

  const remove = async (id: string) => {
    try {
      await api("DELETE", `/api/audiences/${selected}/contacts/${id}`);
      setContacts((p) => p.filter((c) => c.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  };


  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <div>
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Audience</h1>
          <p className="text-sm text-muted-foreground">Your subscribers, stored in this app. Only confirmed contacts receive sends.</p>
        </div>
        <div className="flex items-center gap-2">
          {status?.crm_connected ? (
            <Button variant="outline" disabled={!selected} onClick={() => setCrmOpen(true)}>
              <Database size={15} /> Import from CRM
            </Button>
          ) : null}
          <Button variant="outline" size="icon" onClick={() => load(selected)} aria-label="Refresh">
            <RefreshCw size={16} />
          </Button>
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-8 py-6">

      {status?.crm_connected && selected ? (
        <CrmImportDialog
          open={crmOpen}
          onOpenChange={setCrmOpen}
          audienceId={selected}
          audienceName={audiences.find((a: ResendAudience) => a.id === selected)?.name ?? ""}
          onImported={() => load(selected)}
        />
      ) : null}

      <div className="mb-4 w-72">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger>
            <SelectValue placeholder={audiences.length ? "Select audience" : "No audiences yet"} />
          </SelectTrigger>
          <SelectContent>
            {audiences.map((a: ResendAudience) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {current ? <PendingSummary audience={current} busy={sendingConfirmations} onSend={sendConfirmations} message={confirmMsg} /> : null}

      <div className="mb-4 flex gap-2 rounded-md bg-card p-3 shadow-edge">
        <Input placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input className="w-40" placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
        <Button disabled={!selected || !email.trim()} onClick={add}>
          <Plus size={15} /> Add
        </Button>
      </div>

      <div className="overflow-hidden rounded-md bg-card shadow-edge">
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : contacts.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No contacts in this audience yet.</div>
        ) : (
          <ul className="divide-y">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{c.email}</div>
                  {c.first_name || c.last_name ? (
                    <div className="truncate text-xs text-muted-foreground">{[c.first_name, c.last_name].filter(Boolean).join(" ")}</div>
                  ) : null}
                </div>
                {c.consent_source === "crm_sync" ? (
                  <span className="rounded-xs bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Imported from your CRM with recorded consent">
                    CRM
                  </span>
                ) : null}
                {c.status && c.status !== "subscribed" ? (
                  <span
                    className={`rounded-xs px-1.5 py-0.5 text-xs ${
                      c.status === "pending" && c.confirm_error && !c.confirm_sent_at ? "bg-destructive-tint text-destructive" : "bg-muted text-muted-foreground"
                    }`}
                    title={
                      c.status === "pending"
                        ? pendingHint(c)
                        : c.status === "bounced"
                          ? "Delivery failed permanently"
                          : "Unsubscribed"
                    }
                  >
                    {c.status === "pending"
                      ? c.confirm_sent_at
                        ? "Pending"
                        : c.confirm_error
                          ? "Email failed"
                          : "Not emailed"
                      : c.status === "bounced"
                        ? "Bounced"
                        : "Unsub"}
                  </span>
                ) : null}
                <button className="rounded-lg p-2 text-muted-foreground hover:text-destructive" onClick={() => remove(c.id)} aria-label="Remove contact">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}

function pendingHint(c: ResendContact): string {
  if (!c.confirm_sent_at) {
    return c.confirm_error
      ? `Hasn't confirmed. The confirmation email couldn't be sent: ${c.confirm_error}`
      : "Hasn't confirmed, and no confirmation email has gone out yet. Not included in sends.";
  }
  const n = c.confirm_attempts ?? 1;
  const failed = c.confirm_error ? ` The last reminder couldn't be sent: ${c.confirm_error}` : "";
  return `Hasn't confirmed. ${n} confirmation email${n === 1 ? "" : "s"} sent, the last on ${new Date(c.confirm_sent_at).toLocaleDateString()}.${failed} Not included in sends.`;
}

/**
 * Who is waiting to confirm, and the one action that helps them. People
 * nobody ever emailed (added by hand, or the email failed) are the ones a
 * list silently loses; they are named first.
 */
function PendingSummary({
  audience,
  busy,
  onSend,
  message,
}: {
  audience: ResendAudience;
  busy: boolean;
  onSend: () => void;
  message: string | null;
}) {
  const pending = audience.pending_count ?? 0;
  const unsent = audience.pending_unsent ?? 0;
  const due = audience.pending_due ?? 0;
  if (pending === 0 && !message) return null;
  const parts = [`${audience.subscribed_count ?? 0} confirmed`, `${pending} waiting to confirm`];
  const owed = unsent + due;
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-3 rounded-md p-3 text-sm shadow-edge ${unsent > 0 ? "bg-warning-tint" : "bg-card"}`}>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{parts.join(" · ")}</p>
        <p className="text-xs text-muted-foreground">
          {unsent > 0
            ? `${unsent} never got a confirmation email${due ? `, ${due} ${due === 1 ? "is" : "are"} owed a reminder` : ""}. Only confirmed people receive your newsletter.`
            : due > 0
              ? `${due} ${due === 1 ? "hasn't" : "haven't"} confirmed a day after the email. One reminder each can help (at most two).`
              : "Everyone waiting has been emailed a confirmation link."}
        </p>
        {message ? <p className="mt-1 text-xs">{message}</p> : null}
      </div>
      {owed > 0 ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={onSend}>
          <Send size={14} /> {busy ? "Sending…" : `Send ${owed} confirmation email${owed === 1 ? "" : "s"}`}
        </Button>
      ) : null}
    </div>
  );
}
