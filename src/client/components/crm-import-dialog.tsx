import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface CrmRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  company_name: string | null;
  title: string;
  /** Status of the matching row in this audience, or null when not present. */
  in_audience: "pending" | "subscribed" | "unsubscribed" | "bounced" | null;
}

interface CrmPage {
  contacts: CrmRow[];
  total: number;
  page: number;
  limit: number;
}

interface ImportResult {
  imported: number;
  skipped: { id: string; reason: string }[];
}

/**
 * Pick people out of the workspace CRM and make them subscribers here.
 *
 * The CRM row is never mailed as-is: the operator has to say how consent was
 * obtained before anyone is imported, and that sentence is stored on every row
 * it creates. That is the whole difference between a CRM and a mailing list.
 */
export function CrmImportDialog({
  open,
  onOpenChange,
  audienceId,
  audienceName,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  audienceId: string;
  audienceName: string;
  onImported: () => void;
}) {
  const { setError } = useStore();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CrmPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(page), audience_id: audienceId });
      if (search.trim()) q.set("search", search.trim());
      setData(await api<CrmPage>("GET", `/api/crm/contacts?${q.toString()}`));
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setResult(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page, audienceId]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectable = (data?.contacts ?? []).filter((c) => c.in_audience !== "subscribed" && c.in_audience !== "unsubscribed");
  const allPicked = selectable.length > 0 && selectable.every((c) => picked.has(c.id));

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<ImportResult>("POST", `/api/audiences/${audienceId}/import-crm`, {
        contact_ids: Array.from(picked),
        consent_evidence: evidence,
      });
      setResult(r);
      setPicked(new Set());
      onImported();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from CRM</DialogTitle>
          <DialogDescription>
            Into <span className="font-medium text-foreground">{audienceName || "this audience"}</span>. The CRM keeps the person; this
            list keeps their consent. Only people you can show agreed to hear from you belong here.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-2.5 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search name, email, company"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(1);
                  load();
                }
              }}
            />
          </div>
          <Button variant="outline" onClick={() => { setPage(1); load(); }}>
            Search
          </Button>
        </div>

        <div className="max-h-72 overflow-auto rounded-xl border">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading from CRM…</div>
          ) : !data || data.contacts.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">No CRM contacts with an email address match.</div>
          ) : (
            <ul className="divide-y">
              <li className="flex items-center gap-3 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={allPicked}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (allPicked) selectable.forEach((c) => n.delete(c.id));
                      else selectable.forEach((c) => n.add(c.id));
                      return n;
                    })
                  }
                />
                <span>
                  {data.total} in CRM · page {data.page} of {pages}
                </span>
              </li>
              {data.contacts.map((c) => {
                const blocked = c.in_audience === "subscribed" || c.in_audience === "unsubscribed";
                return (
                  <li key={c.id} className={`flex items-center gap-3 px-3 py-2 ${blocked ? "opacity-60" : ""}`}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.email}`}
                      disabled={blocked}
                      checked={picked.has(c.id)}
                      onChange={() => toggle(c.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        {[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}
                        {c.company_name ? <span className="text-muted-foreground"> · {c.company_name}</span> : null}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{c.email}</div>
                    </div>
                    {c.in_audience ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {c.in_audience === "subscribed" ? "Already in" : c.in_audience === "unsubscribed" ? "Opted out" : c.in_audience}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{picked.size} selected</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="ghost" size="sm" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium" htmlFor="crm-evidence">
            How did these people agree to receive this newsletter?
          </label>
          <Textarea
            id="crm-evidence"
            rows={2}
            placeholder='e.g. "Existing customers, newsletter opt-in ticked on the signed order form"'
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Stored on every imported contact as their consent record. People who unsubscribed here before are skipped and must opt in again.
          </p>
        </div>

        {result ? (
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            Imported {result.imported}.{" "}
            {result.skipped.length ? `Skipped ${result.skipped.length}: ${result.skipped.map((s) => s.reason).join("; ")}.` : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={busy || picked.size === 0 || evidence.trim().length < 12} onClick={run}>
            {busy ? "Importing…" : `Import ${picked.size || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
