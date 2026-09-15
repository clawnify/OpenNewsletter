import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, Database, Upload, Search, X, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ResendAudience, ResendContact, ResendContactPage } from "../../shared/types";
import {
  CONTACT_PAGE_SIZE,
  CONTACT_SORTS,
  isContactSort,
  type ContactSort,
} from "../../shared/contact-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CrmImportDialog } from "./crm-import-dialog";
import { CsvImportDialog } from "./csv-import-dialog";

export function AudienceView() {
  const { status, setError } = useStore();
  const audiences = status?.audiences || [];
  const [selected, setSelected] = useState<string>("");
  const [data, setData] = useState<ResendContactPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");
  const [crmOpen, setCrmOpen] = useState(false);
  const [csvOpen, setCsvOpen] = useState(false);

  // Filters are split in two on purpose. `draft` is what is currently typed and
  // changes on every keystroke; `search` is what has been submitted and is what
  // the request is built from. Typing therefore never costs a query — only
  // Enter (or the button) moves `draft` into `search`.
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<ContactSort>("date_desc");
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!selected && audiences.length) setSelected(audiences[0].id);
  }, [audiences, selected]);

  const contacts = data?.contacts ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit ?? CONTACT_PAGE_SIZE;
  // The server's page, not the requested one: it clamps a page past the end,
  // and the range below has to describe the rows that actually came back.
  const shownPage = data?.page ?? page;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const firstOnPage = total === 0 ? 0 : (shownPage - 1) * limit + 1;
  const lastOnPage = Math.min(total, shownPage * limit);
  const filtersActive = !!search || !!from || !!to || sort !== "date_desc";

  const load = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(page), sort });
      if (search) q.set("search", search);
      if (from) q.set("from", from);
      if (to) q.set("to", to);
      const res = await api<ResendContactPage>("GET", `/api/audiences/${selected}/contacts?${q}`);
      setData(res);
      // The server clamps a page that a filter has made out of range. Adopting
      // its answer keeps the pager showing the page that actually rendered
      // instead of the one that was asked for.
      if (res.page !== page) setPage(res.page);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selected, page, sort, search, from, to, setError]);

  useEffect(() => {
    load();
  }, [load]);

  const submitSearch = () => {
    setSearch(draft.trim());
    setPage(1);
  };

  const clearFilters = () => {
    setDraft("");
    setSearch("");
    setFrom("");
    setTo("");
    setSort("date_desc");
    setPage(1);
  };

  // Date and sort controls apply immediately — they are discrete choices, not
  // text, so there is nothing to be gained by making the reader confirm them.
  const changeDate = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(1);
  };

  const add = async () => {
    if (!email.trim()) return;
    try {
      await api<ResendContact>("POST", `/api/audiences/${selected}/contacts`, {
        email: email.trim(),
        first_name: first.trim() || undefined,
      });
      setEmail("");
      setFirst("");
      // Refetch instead of prepending locally: `total` has to move with the
      // row, and a new contact sorts by `created_at`, which may not be first
      // under the current sort.
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api("DELETE", `/api/audiences/${selected}/contacts/${id}`);
      await load();
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
          <Button variant="outline" disabled={!selected} onClick={() => setCsvOpen(true)}>
            <Upload size={15} /> Import CSV
          </Button>
          {status?.crm_connected ? (
            <Button variant="outline" disabled={!selected} onClick={() => setCrmOpen(true)}>
              <Database size={15} /> Import from CRM
            </Button>
          ) : null}
          <Button variant="outline" size="icon" onClick={load} aria-label="Refresh">
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
            onImported={load}
          />
        ) : null}

        {selected ? (
          <CsvImportDialog
            open={csvOpen}
            onOpenChange={setCsvOpen}
            audienceId={selected}
            audienceName={audiences.find((a: ResendAudience) => a.id === selected)?.name ?? ""}
            onImported={load}
          />
        ) : null}

        <div className="mb-4 flex items-center gap-2">
          <div className="w-64">
            <Select value={selected} onValueChange={(v) => { setSelected(v); setPage(1); }}>
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
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {loading && !data ? "Loading…" : total === 0 ? "No contacts" : `${firstOnPage}–${lastOnPage} of ${total}`}
          </p>
        </div>

        {/* Filters. The search box is a form so Enter submits it natively — no
            key handler, and it behaves like a search field should in a browser. */}
        <form
          className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-card p-3 shadow-edge"
          onSubmit={(e) => { e.preventDefault(); submitSearch(); }}
        >
          <div className="relative min-w-56 flex-1">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              className="pl-8 pr-8"
              placeholder="Search name or email"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Search contacts"
            />
            {draft ? (
              <button
                type="button"
                className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground hover:text-foreground"
                onClick={() => { setDraft(""); if (search) { setSearch(""); setPage(1); } }}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
          <Button type="submit" variant="secondary">Search</Button>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Added
            <Input
              type="date"
              className="w-36"
              value={from}
              max={to || undefined}
              onChange={(e) => changeDate(setFrom)(e.target.value)}
              aria-label="Added after"
            />
            –
            <Input
              type="date"
              className="w-36"
              value={to}
              min={from || undefined}
              onChange={(e) => changeDate(setTo)(e.target.value)}
              aria-label="Added before"
            />
          </label>

          <div className="w-40">
            <Select value={sort} onValueChange={(v) => { if (isContactSort(v)) { setSort(v); setPage(1); } }}>
              <SelectTrigger aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {filtersActive ? (
            <Button type="button" variant="ghost" onClick={clearFilters}>Clear</Button>
          ) : null}
        </form>

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
            <div className="p-6 text-center text-sm text-muted-foreground">
              {/* "No contacts yet" and "nothing matched" are different
                  situations, and only the second one is fixable by the reader. */}
              {filtersActive ? "No contacts match these filters." : "No contacts in this audience yet."}
            </div>
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
                  {/* Shown because "date added" is a filter here — a filter you
                      can set but not see the effect of is guesswork. */}
                  <span className="shrink-0 text-xs text-muted-foreground" title="Date added">
                    {formatAdded(c.created_at)}
                  </span>
                  {c.consent_source === "crm_sync" ? (
                    <span className="rounded-xs bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Imported from your CRM with recorded consent">
                      CRM
                    </span>
                  ) : null}
                  {c.origin === "csv" ? (
                    <span className="rounded-xs bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title="Imported from a CSV file">
                      CSV
                    </span>
                  ) : null}
                  {c.status && c.status !== "subscribed" ? (
                    <span
                      className="rounded-xs bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      title={
                        c.status === "pending"
                          ? "Signed up but hasn't confirmed — not included in sends"
                          : c.status === "bounced"
                            ? "Delivery failed permanently"
                            : "Unsubscribed"
                      }
                    >
                      {c.status === "pending" ? "Pending" : c.status === "bounced" ? "Bounced" : "Unsub"}
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

        {total > 0 && totalPages > 1 ? (
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Page {shownPage} of {totalPages} · {limit} per page
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={shownPage <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft size={15} /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={shownPage >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight size={15} />
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The "date added" part of a timestamp, for display.
 *
 * `created_at` has two shapes in this table — SQLite's own
 * `"2026-09-15 14:32:07"` default and ISO strings written by the app — and only
 * the first is parsed reliably by browsers (the space-separated form is not
 * valid ISO 8601). That form is also the common one, so rather than guess, the
 * date is read off the string directly: both formats begin with `YYYY-MM-DD`.
 * No timezone shifting, no "Invalid Date" for rows the app did not write.
 */
function formatAdded(createdAt?: string): string {
  const day = (createdAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  return day;
}
