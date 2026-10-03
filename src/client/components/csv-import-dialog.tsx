import { useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { parseCsv } from "../../shared/csv";
import {
  guessColumns,
  guessStatus,
  mapRows,
  statusFromFileName,
  statusValues,
  type ColumnMap,
  type Field,
  type ImportRow,
  type StatusChoice,
} from "../../shared/import-map";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const CHUNK = 500; // matches IMPORT_CHUNK on the server
const MIN_EVIDENCE = 12;

const CHOICES: { value: StatusChoice; label: string }[] = [
  { value: "subscribed", label: "Subscribed" },
  { value: "pending", label: "Waiting to confirm" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "bounced", label: "Bounced or complained" },
  { value: "skip", label: "Don't import" },
];

const COLUMNS: { field: Field; label: string }[] = [
  { field: "email", label: "Email" },
  { field: "first_name", label: "First name" },
  { field: "last_name", label: "Last name" },
  { field: "name", label: "Full name" },
  { field: "status", label: "Status" },
  { field: "opted_in_at", label: "Opt-in date" },
];

interface ParsedFile {
  name: string;
  header: string[];
  rows: string[][];
  cols: ColumnMap;
  /** Status for every row (from the file name or the operator), or null to read the status column. */
  fileStatus: StatusChoice | null;
  values: Record<string, StatusChoice>;
}

interface Outcome {
  added: { subscribed: number; pending: number; unsubscribed: number; bounced: number };
  confirmed: number;
  suppressed: number;
  unchanged: number;
  rejected: { email: string; reason: string }[];
}

/**
 * Bring a list over from another platform. Nothing leaves the browser until
 * the operator has seen how each column and status value will be read, and
 * people who were subscribed elsewhere only become subscribers here with a
 * stated reason; without one they wait for a confirmation email.
 */
export function CsvImportDialog({
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
  const [files, setFiles] = useState<ParsedFile[]>([]);
  const [evidence, setEvidence] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const reset = () => {
    setFiles([]);
    setEvidence("");
    setProgress(null);
    setOutcome(null);
  };

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    const parsed: ParsedFile[] = [];
    for (const f of Array.from(list)) {
      const [header = [], ...rows] = parseCsv(await f.text());
      const cols = guessColumns(header);
      const values: Record<string, StatusChoice> = {};
      for (const v of statusValues(rows, cols.status)) values[v.value] = guessStatus(v.value);
      parsed.push({ name: f.name, header, rows, cols, fileStatus: statusFromFileName(f.name), values });
    }
    setOutcome(null);
    setFiles(parsed);
  };

  const update = (i: number, patch: Partial<ParsedFile>) => setFiles((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const mapped = useMemo(() => {
    const rows: ImportRow[] = [];
    let skipped = 0;
    for (const f of files) {
      if (f.cols.email < 0) continue;
      const m = mapRows(f.rows, f.cols, { file: f.fileStatus, values: f.values });
      rows.push(...m.rows);
      skipped += m.skipped;
    }
    const by = { subscribed: 0, pending: 0, unsubscribed: 0, bounced: 0 };
    for (const r of rows) by[r.status]++;
    const ownRecord = rows.filter((r) => r.status === "subscribed" && (r.evidence?.length ?? 0) >= MIN_EVIDENCE).length;
    return { rows, skipped, by, needConsent: by.subscribed - ownRecord };
  }, [files]);

  const missingEmail = files.some((f) => f.cols.email < 0);
  const consentGiven = evidence.trim().length >= MIN_EVIDENCE;
  const busy = progress !== null && outcome === null;

  const run = async () => {
    const rows = mapped.rows;
    const total: Outcome = { added: { subscribed: 0, pending: 0, unsubscribed: 0, bounced: 0 }, confirmed: 0, suppressed: 0, unchanged: 0, rejected: [] };
    const source = `CSV import of ${files.map((f) => f.name).join(", ")} on ${new Date().toISOString().slice(0, 10)}`;
    setProgress({ done: 0, total: rows.length });
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const r = await api<Outcome>("POST", `/api/audiences/${audienceId}/import`, {
          rows: rows.slice(i, i + CHUNK),
          evidence: evidence.trim(),
          source,
        });
        for (const k of Object.keys(total.added) as (keyof Outcome["added"])[]) total.added[k] += r.added[k];
        total.confirmed += r.confirmed;
        total.suppressed += r.suppressed;
        total.unchanged += r.unchanged;
        total.rejected.push(...r.rejected);
        setProgress({ done: Math.min(i + CHUNK, rows.length), total: rows.length });
      }
    } catch (e) {
      setError(`Import stopped part way: ${(e as Error).message}. Rows already sent are in; importing the same file again is safe.`);
    } finally {
      setOutcome(total);
      onImported();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (busy) return;
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import a CSV</DialogTitle>
          <DialogDescription>
            Into <span className="font-medium text-foreground">{audienceName || "this audience"}</span>. Use the export from Mailchimp,
            Substack, beehiiv, Kit, Ghost, Buttondown or this app. Mailchimp exports a zip: unzip it and pick all its files at once.
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <ResultSummary outcome={outcome} />
        ) : files.length === 0 ? (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md p-8 text-center text-sm text-muted-foreground shadow-edge hover:bg-muted/40">
            <FileUp size={20} />
            <span>Choose one or more .csv files</span>
            <input type="file" accept=".csv,text/csv" multiple className="sr-only" onChange={(e) => pick(e.target.files)} />
          </label>
        ) : (
          <>
            {files.map((f, i) => (
              <FileMapping key={f.name + i} file={f} onChange={(p) => update(i, p)} />
            ))}

            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <p className="font-medium">
                {mapped.rows.length} to import: {mapped.by.subscribed} subscribed, {mapped.by.pending} waiting to confirm,{" "}
                {mapped.by.unsubscribed} unsubscribed, {mapped.by.bounced} bounced.
                {mapped.skipped ? ` ${mapped.skipped} not imported.` : ""}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Unsubscribed and bounced people are kept so they are never mailed, and they also stop anyone already here with the same
                address from being mailed. Nobody already here loses their consent.
              </p>
            </div>

            {mapped.needConsent > 0 ? (
              <div>
                <label className="mb-1 block text-sm font-medium" htmlFor="csv-evidence">
                  How did the {mapped.needConsent} subscribed people agree to receive this newsletter?
                </label>
                <Textarea
                  id="csv-evidence"
                  rows={2}
                  placeholder='e.g. "Signed up through the form on our site while we used Mailchimp, double opt-in"'
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {consentGiven
                    ? "Stored on each of them as their consent record, with their original opt-in date when the file has one."
                    : "Leave this empty and they come in waiting to confirm: each gets a confirmation email when you send them from this page."}
                </p>
              </div>
            ) : null}
          </>
        )}

        {progress && !outcome ? (
          <div className="text-sm text-muted-foreground" role="status">
            Importing {progress.done} of {progress.total}…
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {outcome || files.length ? (
            <Button variant="outline" disabled={busy} onClick={reset}>
              {outcome ? "Import another file" : "Start over"}
            </Button>
          ) : null}
          {outcome ? (
            <Button onClick={() => { reset(); onOpenChange(false); }}>Done</Button>
          ) : files.length ? (
            <Button disabled={busy || missingEmail || mapped.rows.length === 0} onClick={run}>
              {busy ? "Importing…" : `Import ${mapped.rows.length}`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileMapping({ file, onChange }: { file: ParsedFile; onChange: (p: Partial<ParsedFile>) => void }) {
  const values = statusValues(file.rows, file.cols.status);
  const setCol = (field: Field, idx: number) => {
    const cols = { ...file.cols, [field]: idx };
    const vals: Record<string, StatusChoice> = {};
    if (field === "status") for (const v of statusValues(file.rows, idx)) vals[v.value] = guessStatus(v.value);
    onChange(field === "status" ? { cols, values: vals } : { cols });
  };
  return (
    <section className="rounded-md p-3 shadow-edge">
      <p className="mb-2 truncate text-sm font-medium">
        {file.name} <span className="font-normal text-muted-foreground">· {file.rows.length} rows</span>
      </p>
      {file.cols.email < 0 ? (
        <p className="mb-2 rounded-xs bg-destructive-tint px-2 py-1 text-xs text-destructive">Pick the column that holds the email address.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {COLUMNS.map(({ field, label }) => (
          <div key={field}>
            <span className="mb-0.5 block text-xs text-muted-foreground">{label}</span>
            <Select value={String(file.cols[field])} onValueChange={(v) => setCol(field, Number(v))}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="-1">Not in this file</SelectItem>
                {file.header.map((h, i) => (
                  <SelectItem key={i} value={String(i)}>
                    {h || `Column ${i + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-xs text-muted-foreground">Status</span>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>Everyone in this file is</span>
          <ChoiceSelect
            value={file.fileStatus ?? (file.cols.status >= 0 ? "column" : "subscribed")}
            withColumn={file.cols.status >= 0}
            onChange={(v) => onChange({ fileStatus: v === "column" ? null : (v as StatusChoice) })}
          />
        </div>
        {file.fileStatus === null && file.cols.status >= 0 ? (
          <ul className="mt-2 space-y-1">
            {values.slice(0, 12).map((v) => (
              <li key={v.value} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  “{v.value || "(empty)"}” <span className="text-muted-foreground">· {v.count}</span>
                </span>
                <ChoiceSelect
                  value={file.values[v.value] ?? guessStatus(v.value)}
                  onChange={(c) => onChange({ values: { ...file.values, [v.value]: c as StatusChoice } })}
                />
              </li>
            ))}
            {values.length > 12 ? <li className="text-xs text-muted-foreground">{values.length - 12} more values, read by their closest match.</li> : null}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function ChoiceSelect({ value, onChange, withColumn }: { value: string; onChange: (v: string) => void; withColumn?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 w-48 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {withColumn ? <SelectItem value="column">Read from the status column</SelectItem> : null}
        {CHOICES.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ResultSummary({ outcome }: { outcome: Outcome }) {
  const a = outcome.added;
  const lines = [
    `Added ${a.subscribed + a.pending + a.unsubscribed + a.bounced}: ${a.subscribed} subscribed, ${a.pending} waiting to confirm, ${a.unsubscribed} unsubscribed, ${a.bounced} bounced.`,
    outcome.confirmed ? `${outcome.confirmed} who were waiting to confirm here are now subscribed.` : "",
    outcome.suppressed ? `${outcome.suppressed} already here won't be mailed any more: they had opted out or bounced on the old platform.` : "",
    outcome.unchanged ? `${outcome.unchanged} already here were left as they were.` : "",
  ].filter(Boolean);
  return (
    <div className="rounded-md bg-muted/50 p-3 text-sm" role="status">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {outcome.rejected.length ? (
        <details className="mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{outcome.rejected.length} rows refused</summary>
          <ul className="mt-1 max-h-32 overflow-auto">
            {outcome.rejected.slice(0, 200).map((r, i) => (
              <li key={i}>
                {r.email}: {r.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
