import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, Database, Send, FileUp, Download, Search, MailQuestion } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { InactiveSummary, Mail, ResendAudience, ResendContact } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CrmImportDialog } from "./crm-import-dialog";
import { CsvImportDialog } from "./csv-import-dialog";

const PAGE = 50;

export function AudienceView({ openMail }: { openMail: (id: number) => void }) {
  const { status, setError, refreshStatus } = useStore();
  const audiences = status?.audiences || [];
  const [selected, setSelected] = useState<string>("");
  const [contacts, setContacts] = useState<ResendContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [crmOpen, setCrmOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [next, setNext] = useState<string | null>(null);

  useEffect(() => {
    if (!selected && audiences.length) setSelected(audiences[0].id);
  }, [audiences, selected]);

  // A page at a time: an imported list can hold tens of thousands of people.
  const load = async (id: string, cursor: string | null = null) => {
    if (!id) return;
    setLoading(true);
    try {
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (search.trim()) q.set("search", search.trim());
      if (statusFilter !== "all") q.set("status", statusFilter);
      if (cursor) q.set("cursor", cursor);
      const r = await api<{ contacts: ResendContact[]; next: string | null }>("GET", `/api/audiences/${id}/contacts?${q}`);
      setContacts((p) => (cursor ? [...p, ...r.contacts] : r.contacts));
      setNext(r.next);
    } catch (e) {
      setError((e as Error).message);
      if (!cursor) setContacts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selected) load(selected);
  }, [selected, statusFilter]);

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
          <Button variant="outline" disabled={!selected} onClick={() => setCsvOpen(true)}>
            <FileUp size={15} /> Import CSV
          </Button>
          {selected ? (
            <Button variant="outline" asChild>
              <a href={`/api/audiences/${selected}/export`} download>
                <Download size={15} /> Export
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="icon" onClick={() => { load(selected); refreshStatus(); }} aria-label="Refresh">
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

      {selected ? (
        <CsvImportDialog
          open={csvOpen}
          onOpenChange={setCsvOpen}
          audienceId={selected}
          audienceName={current?.name ?? ""}
          onImported={() => {
            load(selected);
            refreshStatus();
          }}
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
      {current ? <InactiveCard audienceId={current.id} openMail={openMail} /> : null}

      <div className="mb-4 flex gap-2 rounded-md bg-card p-3 shadow-edge">
        <Input placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input className="w-40" placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
        <Button disabled={!selected || !email.trim()} onClick={add}>
          <Plus size={15} /> Add
        </Button>
      </div>

      <div className="mb-2 flex gap-2">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search email or name"
            aria-label="Search contacts"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") load(selected);
            }}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone</SelectItem>
            <SelectItem value="subscribed">Subscribed</SelectItem>
            <SelectItem value="pending">Waiting to confirm</SelectItem>
            <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
            <SelectItem value="bounced">Bounced</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-hidden rounded-md bg-card shadow-edge">
        {loading && contacts.length === 0 ? (
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
                {c.consent_source === "import" && c.status === "subscribed" ? (
                  <span className="rounded-xs bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Imported with a recorded consent statement">
                    Imported
                  </span>
                ) : null}
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
                          : c.unsubscribe_reason === "inactive"
                            ? "Stopped after not answering a “still want this?” email. Signing up again, or the button in that email, brings them back."
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
                        : c.unsubscribe_reason === "inactive"
                          ? "Inactive"
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
      {next ? (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => load(selected, next)}>
            {loading ? "Loading…" : "Show more"}
          </Button>
        </div>
      ) : null}
      </div>
    </div>
  );
}

/**
 * Subscribers who stopped reading, and the one action for them: ask whether
 * they want to stay. The ask opens as a draft issue; nothing is removed until
 * it has been sent and they've had the grace period to answer.
 */
function InactiveCard({ audienceId, openMail }: { audienceId: string; openMail: (id: number) => void }) {
  const { setError, refreshMails } = useStore();
  const [days, setDays] = useState("90");
  const [sum, setSum] = useState<InactiveSummary | null>(null);
  const [busy, setBusy] = useState(false);

  // Another audience's count must never sit next to a live "Ask them".
  useEffect(() => {
    setSum(null);
    setDays("90");
  }, [audienceId]);

  useEffect(() => {
    let live = true;
    api<InactiveSummary>("GET", `/api/audiences/${audienceId}/inactive?days=${days}`)
      .then((r) => live && setSum(r))
      .catch(() => live && setSum(null));
    return () => { live = false; };
  }, [audienceId, days]);

  // Hidden only at the default window: after picking a longer one, the picker stays to switch back.
  if (!sum || (sum.inactive === 0 && sum.asked === 0 && days === "90")) return null;

  const ask = async () => {
    setBusy(true);
    try {
      const mail = await api<Mail>("POST", `/api/audiences/${audienceId}/ask-inactive`, { days: Number(days) });
      await refreshMails();
      openMail(mail.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const people = (n: number) => `${n.toLocaleString()} ${n === 1 ? "subscriber" : "subscribers"}`;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-md bg-card p-3 text-sm shadow-edge">
      <MailQuestion size={18} className="shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        {sum.inactive > 0 ? (
          <>
            <p className="font-medium">
              {people(sum.inactive)} haven't opened or clicked in {sum.days} days
            </p>
            <p className="text-xs text-muted-foreground">
              Each got at least {sum.min_received} issues since. Ask if they still want it: whoever doesn't answer within {sum.grace_days} days
              stops getting your newsletter, which keeps your sender reputation healthy.
            </p>
          </>
        ) : null}
        {sum.inactive === 0 && sum.asked === 0 ? (
          <p className="text-muted-foreground">Nobody has gone {sum.days} days without opening or clicking.</p>
        ) : null}
        {sum.asked > 0 ? (
          <p className={sum.inactive > 0 ? "mt-1 text-xs" : "font-medium"}>
            {people(sum.asked)} asked and not answered yet.
            {sum.removes_from ? ` The first stop getting it ${new Date(sum.removes_from).toLocaleDateString()} unless they open, click or press “keep me”.` : ""}
          </p>
        ) : null}
        {sum.inactive > 0 && sum.blocked ? <p className="mt-1 text-xs text-warning">{sum.blocked}</p> : null}
      </div>
      {sum.inactive > 0 || days !== "90" ? (
        <div className="flex items-center gap-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-8 w-28" aria-label="Inactive for">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="90">90 days</SelectItem>
              <SelectItem value="180">180 days</SelectItem>
              <SelectItem value="365">1 year</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={busy || !!sum.blocked || sum.inactive === 0} onClick={ask}>
            {busy ? "Writing…" : "Ask them"}
          </Button>
        </div>
      ) : null}
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
