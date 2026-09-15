import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Upload, FileText, TriangleAlert } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import {
  buildPreview,
  guessCsvMapping,
  importVerdict,
  parseCsv,
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
  type CsvDelimiter,
  type CsvField,
  type CsvPreview,
  type CsvTable,
  type PriorStatus,
} from "../../shared/csv";
import { validateEvidence, MIN_EVIDENCE_LENGTH } from "../../shared/consent";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ImportResult {
  imported: number;
  subscribed: number;
  pending: number;
  skipped: { line: number; email: string; reason: string }[];
  invalid: { line: number; email: string; reason: string }[];
}

const FIELDS: { value: CsvField; label: string }[] = [
  { value: "ignore", label: "Ignore this column" },
  { value: "email", label: "Email address" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
];

const DELIMITER_LABELS: Record<CsvDelimiter, string> = {
  ",": "Comma ( , )",
  ";": "Semicolon ( ; )",
  "\t": "Tab",
  "|": "Pipe ( | )",
};

/** Existing status for an address, so the preview can say who will be skipped. */
type StatusLookup = Record<string, PriorStatus>;

/**
 * Import subscribers from a CSV the operator has on their machine.
 *
 * The file is read and parsed in the browser, which is why nothing here needs
 * an upload endpoint: the operator sees exactly what would be imported — every
 * skipped row, every duplicate, every unmapped column — before anything is
 * sent. Then the same consent rule as the CRM import applies, because a row in
 * a spreadsheet is not evidence that anyone agreed to be mailed.
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
  const fileRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState("");
  const [raw, setRaw] = useState("");
  const [delimiter, setDelimiter] = useState<CsvDelimiter | "auto">("auto");
  const [hasHeader, setHasHeader] = useState(true);
  const [mapping, setMapping] = useState<CsvField[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  const [statuses, setStatuses] = useState<StatusLookup>({});
  const [markSubscribed, setMarkSubscribed] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const table: CsvTable | null = useMemo(
    () => (raw ? parseCsv(raw, { delimiter, has_header: hasHeader }) : null),
    [raw, delimiter, hasHeader],
  );
  const preview: CsvPreview | null = useMemo(
    () => (table ? buildPreview(table, mapping) : null),
    [table, mapping],
  );

  // Re-guess the columns when the header set actually changes — a new file, a
  // different separator, or the header-row toggle. Keying on the headers rather
  // than on `raw` means an operator who has just set the columns by hand keeps
  // that work when they change the separator and the headers come out the same.
  const headerKey = table ? table.headers.join("\u0000") : "";
  useEffect(() => {
    if (table) setMapping(guessCsvMapping(table.headers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headerKey]);

  const reset = () => {
    setFileName("");
    setRaw("");
    setDelimiter("auto");
    setHasHeader(true);
    setMapping([]);
    setFileError(null);
    setResult(null);
    setStatuses({});
    setMarkSubscribed(false);
    setEvidence("");
    setDragging(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  useEffect(() => {
    if (!open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Ask the server who is already on the list, so the preview can show a
  // correct "will be skipped" count instead of discovering it after importing.
  useEffect(() => {
    if (!open || !audienceId || !preview?.has_email || preview.candidates.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api<{ statuses: StatusLookup }>("POST", `/api/audiences/${audienceId}/contact-statuses`, {
          emails: preview.candidates.map((c) => c.email),
        });
        if (!cancelled) setStatuses(r.statuses);
      } catch {
        // A failed lookup only means the preview cannot say who is skipped;
        // the import itself re-checks and reports the same thing.
        if (!cancelled) setStatuses({});
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the addresses, not the array identity, so typing in the consent
    // box does not re-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, audienceId, preview?.has_email, preview?.candidates.map((c) => c.email).join(",")]);

  const pick = async (file: File) => {
    setResult(null);
    setFileError(null);
    if (file.size > MAX_CSV_BYTES) {
      setRaw("");
      setFileName(file.name);
      setFileError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_CSV_BYTES / 1024 / 1024} MB limit. Split it and import in parts.`,
      );
      return;
    }
    try {
      const text = await file.text();
      setFileName(file.name);
      setDelimiter("auto");
      setRaw(text);
    } catch (e) {
      setFileError((e as Error).message);
    }
  };

  const setColumn = (i: number, field: CsvField) =>
    setMapping((m) => {
      const next = [...m];
      // An email column is the whole import, so choosing one moves it rather
      // than leaving two columns both claiming to be the address.
      if (field === "email") next.forEach((v, j) => { if (j !== i && v === "email") next[j] = "ignore"; });
      else if (field !== "ignore") next.forEach((v, j) => { if (j !== i && v === field) next[j] = "ignore"; });
      next[i] = field;
      return next;
    });

  const candidates = preview?.candidates ?? [];
  const verdicts = candidates.map((c) => ({ contact: c, verdict: importVerdict(statuses[c.email]) }));
  const willImport = verdicts.filter((v) => v.verdict.import);
  const overLimit = willImport.length > MAX_IMPORT_ROWS;

  const evidenceOk = markSubscribed ? !!validateEvidence(evidence) : true;
  const canImport = !busy && willImport.length > 0 && !overLimit && evidenceOk;

  const run = async () => {
    setBusy(true);
    try {
      const r = await api<ImportResult>("POST", `/api/audiences/${audienceId}/import-csv`, {
        rows: willImport.slice(0, MAX_IMPORT_ROWS).map((v) => v.contact),
        consent_evidence: markSubscribed ? evidence : "",
        mark_subscribed: markSubscribed,
      });
      setResult(r);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Anything the parser noticed that the operator should see before importing.
  const notes: string[] = [];
  if (table?.unterminated) {
    notes.push("A quoted value is never closed, so this file may be cut short — check it before importing.");
  }
  if (table && table.ragged > 0) {
    notes.push(`${table.ragged} ${table.ragged === 1 ? "row has" : "rows have"} a different number of columns than the header. If that looks wrong, try another separator.`);
  }
  if (table && table.blanks > 0) {
    notes.push(`${table.blanks} blank ${table.blanks === 1 ? "line" : "lines"} ignored.`);
  }
  if (candidates.length > MAX_IMPORT_ROWS) {
    notes.push(
      `This file has ${candidates.length} importable rows, more than the ${MAX_IMPORT_ROWS} one import allows. Only the first ${MAX_IMPORT_ROWS} will be imported — split the file to get the rest.`,
    );
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void pick(f);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`max-w-3xl ${dragging ? "ring-2 ring-ring" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          // Only when the pointer leaves the dialog itself, not on every
          // child-to-child move inside it.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <DialogHeader>
          <DialogTitle>Import from CSV</DialogTitle>
          <DialogDescription>
            Into <span className="font-medium text-foreground">{audienceName || "this audience"}</span>. The file is read in your
            browser — you see every row that will be skipped before anything is saved.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ImportSummary result={result} />
        ) : (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pick(f);
              }}
            />
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => fileRef.current?.click()}>
                <Upload size={15} /> Choose a CSV file
              </Button>
              {fileName ? (
                <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                  <FileText size={14} className="shrink-0" />
                  <span className="truncate">{fileName}</span>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">or drag a file onto this dialog</span>
              )}
            </div>

            {fileError ? <p className="text-sm text-destructive">{fileError}</p> : null}

            {!table ? (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                className={`rounded-md border border-dashed p-6 text-center text-sm ${dragging ? "border-ring text-foreground" : "text-muted-foreground"
                  }`}
              >
                Drop a CSV here, or use <span className="font-medium">Choose a CSV file</span> above.
              </div>
            ) : null}

            {table ? (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="w-44">
                    <Label className="mb-1 text-xs">Separator</Label>
                    <Select value={delimiter} onValueChange={(v) => setDelimiter(v as CsvDelimiter | "auto")}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">
                          Detect automatically{delimiter === "auto" && table ? ` (${DELIMITER_LABELS[table.delimiter]})` : ""}
                        </SelectItem>
                        {(Object.keys(DELIMITER_LABELS) as CsvDelimiter[]).map((d) => (
                          <SelectItem key={d} value={d}>
                            {DELIMITER_LABELS[d]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-2 pb-2 text-sm">
                    <Switch checked={hasHeader} onCheckedChange={setHasHeader} />
                    First row is a header
                  </label>
                  <span className="pb-2 text-xs text-muted-foreground">
                    {table.rows.length} data {table.rows.length === 1 ? "row" : "rows"}
                  </span>
                </div>

                {notes.length ? (
                  <ul className="space-y-1 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                    {notes.map((n, i) => (
                      <li key={i} className="flex gap-1.5">
                        <TriangleAlert size={13} className="mt-px shrink-0" />
                        <span>{n}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {!preview?.has_email ? (
                  <p className="rounded-md bg-muted/50 p-3 text-sm">
                    Choose which column holds the email address — nothing can be imported until one does.
                  </p>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  {table.headers.map((h, i) => (
                    <div key={`${h}-${i}`}>
                      <Label className="mb-1 block truncate text-xs" title={h}>
                        {h}
                      </Label>
                      <Select value={mapping[i] ?? "ignore"} onValueChange={(v) => setColumn(i, v as CsvField)}>
                        <SelectTrigger className={mapping[i] === "email" && !preview?.has_email ? "border-destructive" : ""}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FIELDS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="mt-1 truncate text-xs text-muted-foreground" title={table.rows[0]?.cells[i] ?? ""}>
                        e.g. {table.rows[0]?.cells[i] || "—"}
                      </p>
                    </div>
                  ))}
                </div>

                <RowPreview verdicts={verdicts} invalid={preview?.invalid ?? []} duplicates={preview?.duplicates ?? []} />

                <div className="rounded-md bg-muted/50 p-3">
                  <label className="flex items-start gap-2.5 text-sm">
                    <Switch checked={markSubscribed} onCheckedChange={setMarkSubscribed} className="mt-0.5" />
                    <span>
                      <span className="font-medium">Mark these people as subscribed</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        Only if you can show they agreed to hear from you. Left off, they are added as{" "}
                        <span className="font-medium">pending</span> — saved to the list, but sent nothing until they confirm.
                      </span>
                    </span>
                  </label>

                  {markSubscribed ? (
                    <div className="mt-3">
                      <Label className="mb-1 block text-sm" htmlFor="csv-evidence">
                        How did these people agree to receive this newsletter?
                      </Label>
                      <Textarea
                        id="csv-evidence"
                        rows={2}
                        placeholder='e.g. "Newsletter opt-in ticked on the order form, exported 2026-03-01"'
                        value={evidence}
                        onChange={(e) => setEvidence(e.target.value)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {evidence.trim().length > 0 && !evidenceOk
                          ? `Stored on every imported contact as their consent record. A sentence of at least ${MIN_EVIDENCE_LENGTH} characters, please.`
                          : "Stored on every imported contact as their consent record."}
                      </p>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result ? (
            <Button disabled={!canImport} onClick={run} title={overLimit ? `Only the first ${MAX_IMPORT_ROWS} rows can be imported at once` : undefined}>
              {busy
                ? "Importing…"
                : markSubscribed
                  ? `Import ${Math.min(willImport.length, MAX_IMPORT_ROWS)} as subscribed`.trim()
                  : `Add ${Math.min(willImport.length, MAX_IMPORT_ROWS) || ""} to the list`.trim()}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The rows that will and will not be imported, capped so the dialog stays usable. */
function RowPreview({
  verdicts,
  invalid,
  duplicates,
}: {
  verdicts: { contact: { line: number; email: string; first_name: string }; verdict: { import: boolean; reason?: string } }[];
  invalid: { line: number; email: string; reason: string }[];
  duplicates: { line: number; email: string }[];
}) {
  const LIMIT = 50;
  const imported = verdicts.filter((v) => v.verdict.import);
  const skipped = verdicts.filter((v) => !v.verdict.import);
  const total = imported.length + skipped.length + invalid.length + duplicates.length;
  if (total === 0) return null;

  return (
    <div className="max-h-64 overflow-auto rounded-md shadow-edge">
      <ul className="divide-y text-sm">
        {imported.slice(0, LIMIT).map((v) => (
          <li key={`i-${v.contact.line}`} className="flex items-center gap-2 px-3 py-1.5">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{v.contact.line}</span>
            <span className="min-w-0 flex-1 truncate">{v.contact.email}</span>
            {v.contact.first_name ? (
              <span className="truncate text-xs text-muted-foreground">{v.contact.first_name}</span>
            ) : null}
          </li>
        ))}
        {skipped.slice(0, LIMIT).map((v) => (
          <li key={`s-${v.contact.line}`} className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{v.contact.line}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground line-through">{v.contact.email}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{v.verdict.reason}</span>
          </li>
        ))}
        {invalid.slice(0, LIMIT).map((r) => (
          <li key={`x-${r.line}`} className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{r.line}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.email || "(blank)"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{r.reason}</span>
          </li>
        ))}
        {duplicates.slice(0, LIMIT).map((d) => (
          <li key={`d-${d.line}`} className="flex items-center gap-2 bg-muted/40 px-3 py-1.5">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{d.line}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground line-through">{d.email}</span>
            <span className="shrink-0 text-xs text-muted-foreground">duplicate in this file</span>
          </li>
        ))}
      </ul>
      {total > LIMIT ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {total} rows in total — showing the first {LIMIT} of each kind. All of them are checked the same way.
        </p>
      ) : null}
    </div>
  );
}

/** What actually happened, so the operator can reconcile it against their file. */
function ImportSummary({ result }: { result: ImportResult }) {
  const skipped = [...result.skipped, ...result.invalid.map((i) => ({ line: i.line, email: i.email, reason: i.reason }))];
  return (
    <div className="space-y-3">
      <p className="rounded-md bg-muted/50 p-3 text-sm">
        Imported <span className="font-medium">{result.imported}</span>{" "}
        {result.subscribed > 0
          ? "as subscribed."
          : "as pending — they will receive nothing until they confirm."}
        {skipped.length ? ` ${skipped.length} skipped.` : ""}
      </p>
      {skipped.length ? (
        <ul className="max-h-56 overflow-auto rounded-md text-sm shadow-edge">
          {skipped.slice(0, 50).map((s) => (
            <li key={`${s.line}-${s.email}`} className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0">
              <span className="w-10 shrink-0 text-xs text-muted-foreground">{s.line}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.email || "(blank)"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{s.reason}</span>
            </li>
          ))}
          {skipped.length > 50 ? (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">
              …and {skipped.length - 50} more.
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
