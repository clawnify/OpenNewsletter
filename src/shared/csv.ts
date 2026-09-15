/**
 * CSV parsing for the local contact import.
 *
 * Hand-written rather than pulled from a dependency because the target is what
 * address books actually export, and every one of those quirks fails *silently*
 * with `split(",")`: a comma inside a quoted name, a newline inside a quoted
 * note, CRLF from Excel, a UTF-8 BOM, `;` from a European locale. The row still
 * imports — just with the wrong name in it.
 *
 * Nothing here knows what a "contact" is. The parser returns cells and the
 * caller decides what the columns mean, because no two exports agree on whether
 * column three is a last name, a company, or a note.
 *
 * Lives in `shared/` because it runs in both places: the browser parses the file
 * so a 5 MB export never has to fit in a request body, and the server re-runs
 * the same checks on what was posted so a hand-rolled request can't skip them.
 */

export type CsvDelimiter = "," | ";" | "\t" | "|";

/** Which field of a contact a column feeds. */
export type CsvField = "ignore" | "email" | "first_name" | "last_name";

/** One entry per header, in header order. */
export type CsvMapping = CsvField[];

/** Consent state a contact can already have when an import reaches them. */
export type PriorStatus = "pending" | "subscribed" | "unsubscribed" | "bounced";

/**
 * The import is one request and one D1 write per row, so it is bounded at a
 * thousand. (The CRM import caps at 200 because every row there costs a
 * proxied HTTP read; a CSV row costs nothing before it is staged.)
 */
export const MAX_IMPORT_ROWS = 1000;

/** Past this the file is not a contact list; refuse rather than eat the tab. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

/** Tried in this order, so a tie goes to the comma. */
const DELIMITERS: CsvDelimiter[] = [",", ";", "\t", "|"];

export interface CsvRow {
  /** 1-based line in the source file where the record starts. */
  line: number;
  cells: string[];
}

export interface CsvTable {
  /** How the file was read, so the UI can say so and offer to override it. */
  delimiter: CsvDelimiter;
  headers: string[];
  /** Data rows, each padded/truncated to `headers.length`. */
  rows: CsvRow[];
  /** Blank lines — every export ends with one, and no import wants it. */
  blanks: number;
  /**
   * Rows whose cell count differs from the header. Counted rather than hidden:
   * a ragged file usually means the delimiter was guessed wrong, and the preview
   * below it is then quietly misaligned.
   */
  ragged: number;
  /** A quote left open at EOF swallowed the rest of the file into one cell. */
  unterminated: boolean;
}

export interface ImportRow {
  /**
   * Line in the source file, so a skipped row can be found in the operator's
   * editor. `buildPreview` reads it off the file; a posted import carries the
   * number the browser computed, and the server only falls back to a position
   * when none was sent.
   */
  line: number;
  email: string;
  first_name: string;
  last_name: string;
}

export interface InvalidRow {
  line: number;
  email: string;
  reason: string;
}

export interface CsvPreview {
  /** False when no column is mapped to email: every row is unusable until one is. */
  has_email: boolean;
  candidates: ImportRow[];
  invalid: InvalidRow[];
  /** Rows dropped because the same address appeared earlier in the same file. */
  duplicates: { line: number; email: string }[];
}

export interface ParseCsvOptions {
  /** `auto` (the default) sniffs; anything else is an explicit override. */
  delimiter?: CsvDelimiter | "auto";
  /** Defaults to true — real exports have a header row. */
  has_header?: boolean;
}

// ── primitives ──────────────────────────────────────────────────────────────

export const normalizeEmail = (value: string) => value.trim().toLowerCase();

/**
 * Address-shaped enough to mail: exactly one `@`, a dot in the domain, and no
 * whitespace or list separators. Deliberately not RFC 5322 — the point is to
 * reject the "N/A" and "jane@doe" cells that imports are full of, not to be a
 * validator. A rejected row is reported, never silently dropped.
 */
export function isEmail(value: string): boolean {
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(value.trim());
}

/** Names are decoration; the address is the key. Collapsed, trimmed, bounded. */
function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 100) : "";
}

/** Delimiters outside quotes — an address inside quotes must not vote. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        i++;
        continue;
      }
      quoted = !quoted;
    } else if (ch === delimiter && !quoted) count++;
  }
  return count;
}

function modal(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0;
  let bestCount = 0;
  for (const [value, n] of counts) {
    // `>` and Map insertion order mean a tie keeps the first-seen value.
    if (n > bestCount) {
      best = value;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Guess the delimiter: the one that splits the first few lines into the same
 * number of cells most often, widest split winning a tie.
 *
 * A delimiter that yields one column is not a candidate, however consistently
 * it does so — otherwise a plain comma file scores best on a character that
 * never appears, since "every line has exactly one field" is trivially true of
 * every absent delimiter. Score is only meaningful once a split actually
 * happened, so `fields < 2` is excluded.
 *
 * A two-column `Last, First;Email` file is genuinely ambiguous and will be read
 * as comma-separated — which is why the dialog shows the guess and lets the
 * operator change it instead of pretending the guess is always right.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 5);

  let best: CsvDelimiter = ",";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const cells = lines.map((l) => countOutsideQuotes(l, d) + 1);
    const fields = modal(cells);
    if (fields < 2) continue;
    // Consistency first, then prefer the wider split, then declaration order.
    const score = cells.filter((c) => c === fields).length * 100 + fields;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/**
 * RFC 4180 state machine. `""` inside a quoted field is a literal quote; a
 * quote only opens a field, so `5" nail` survives. Both CRLF and a lone CR end
 * a row. Line numbers are tracked as we go so a quoted field containing
 * newlines doesn't shift every later row number.
 */
function parseRows(text: string, delimiter: string): { rows: CsvRow[]; unterminated: boolean } {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startLine = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push({ line: startLine, cells: row });
      row = [];
      field = "";
      line++;
      startLine = line;
      continue;
    }
    field += ch;
  }
  // EOF flush — but not for the empty tail a trailing newline leaves behind.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push({ line: startLine, cells: row });
  }
  return { rows, unterminated: quoted };
}

// ── parsing ─────────────────────────────────────────────────────────────────

export function parseCsv(text: string, opts: ParseCsvOptions = {}): CsvTable {
  // Excel writes a BOM. Left in place it becomes part of the first header, and
  // the email column silently stops matching anything.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = opts.delimiter && opts.delimiter !== "auto" ? opts.delimiter : sniffDelimiter(clean);
  const { rows: all, unterminated } = parseRows(clean, delimiter);

  const kept = all.filter((r) => r.cells.some((c) => c.trim() !== ""));
  // Blank lines and rows whose every cell is empty (`,,,`) are the same thing
  // to an import — a spacer in the file, not a person — so both count here
  // rather than one becoming an "invalid row" the operator has to read.
  const blanks = all.length - kept.length;

  const hasHeader = opts.has_header ?? true;
  const headerCells = (hasHeader ? kept.shift() ?? { line: 1, cells: [] } : { line: 1, cells: [] }).cells;
  const width = hasHeader
    ? headerCells.length
    : kept.reduce((w, r) => Math.max(w, r.cells.length), 0);
  const headers = hasHeader
    ? headerCells.map((h, i) => h.trim() || `Column ${i + 1}`)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);

  const ragged = kept.filter((r) => r.cells.length !== headers.length).length;
  const rows: CsvRow[] = kept.map((r) => ({
    line: r.line,
    cells: Array.from({ length: headers.length }, (_, i) => (r.cells[i] ?? "").trim()),
  }));

  return { delimiter, headers, rows, blanks, ragged, unterminated };
}

const ALIASES: Record<Exclude<CsvField, "ignore">, string[]> = {
  email: ["email", "emailaddress", "emailid", "mail", "contactemail", "e"],
  first_name: ["firstname", "givenname", "forename", "first", "fname"],
  last_name: ["lastname", "surname", "familyname", "secondname", "last", "lname"],
};

/**
 * Match headers against the spellings exports actually use. A miss is not an
 * error — it just means the operator sets that column by hand — so this stays a
 * guess and every column remains overridable.
 */
export function guessCsvMapping(headers: string[]): CsvMapping {
  const mapping: CsvMapping = headers.map(() => "ignore");
  for (const field of ["email", "first_name", "last_name"] as const) {
    const at = headers.findIndex((h, i) => {
      const key = h.toLowerCase().replace(/[^a-z0-9]/g, "");
      return mapping[i] === "ignore" && ALIASES[field].includes(key);
    });
    if (at >= 0) mapping[at] = field;
  }
  return mapping;
}

/** Turn parsed cells into candidate contacts, dropping what cannot be mailed. */
export function buildPreview(table: CsvTable, mapping: CsvMapping): CsvPreview {
  const emailAt = mapping.indexOf("email");
  if (emailAt < 0) return { has_email: false, candidates: [], invalid: [], duplicates: [] };

  const firstAt = mapping.indexOf("first_name");
  const lastAt = mapping.indexOf("last_name");
  const candidates: ImportRow[] = [];
  const invalid: InvalidRow[] = [];
  const duplicates: { line: number; email: string }[] = [];
  const seen = new Set<string>();

  table.rows.forEach(({ line, cells }) => {
    const raw = cells[emailAt] ?? "";
    if (!isEmail(raw)) {
      invalid.push({ line, email: raw, reason: raw ? "not an email address" : "no email address" });
      return;
    }
    const email = normalizeEmail(raw);
    if (seen.has(email)) {
      duplicates.push({ line, email });
      return;
    }
    seen.add(email);
    candidates.push({
      line,
      email,
      first_name: firstAt >= 0 ? cleanName(cells[firstAt]) : "",
      last_name: lastAt >= 0 ? cleanName(cells[lastAt]) : "",
    });
  });

  return { has_email: true, candidates, invalid, duplicates };
}

/**
 * Validate what was actually posted. The server cannot see the file, so it can
 * only check the rows it was handed — which is the point: the same shapes the
 * preview produced are the only ones that get written. Each row's `line` is
 * kept as sent so a rejection still points at a line the operator can find.
 */
export function stageImportRows(input: unknown): { rows: ImportRow[]; invalid: InvalidRow[] } {
  if (!Array.isArray(input)) return { rows: [], invalid: [] };
  const rows: ImportRow[] = [];
  const invalid: InvalidRow[] = [];
  const seen = new Set<string>();

  input.forEach((raw, i) => {
    const at = i + 1;
    const given = raw && typeof raw === "object" ? Number((raw as ImportRow).line) : NaN;
    const line = Number.isInteger(given) && given > 0 ? given : at;
    if (!raw || typeof raw !== "object") {
      invalid.push({ line, email: "", reason: "malformed row" });
      return;
    }
    const email = normalizeEmail(typeof (raw as ImportRow).email === "string" ? (raw as ImportRow).email : "");
    if (!isEmail(email)) {
      invalid.push({ line, email, reason: email ? "not an email address" : "no email address" });
      return;
    }
    if (seen.has(email)) {
      invalid.push({ line, email, reason: "duplicate address" });
      return;
    }
    seen.add(email);
    rows.push({
      line,
      email,
      first_name: cleanName((raw as ImportRow).first_name),
      last_name: cleanName((raw as ImportRow).last_name),
    });
  });

  return { rows, invalid };
}

/**
 * What an import should do to an address that is already on the list.
 *
 * Spelled out as a value rather than inlined in the route so it can be tested
 * without a database, because the two states it protects are the ones that
 * cannot be undone by hand:
 *
 * - `unsubscribed` — they asked us to stop. Re-importing them is the single
 *   most reliable way to turn a migration into spam complaints.
 * - `subscribed` — their record is already a better one than a row in a file.
 *   Importing would stamp it `import` and discard the evidence that was there.
 * - `bounced` — the address was rejected permanently. A file does not prove it
 *   works now, and mailing it again is deliverability damage for every sender
 *   on the shared infrastructure.
 *
 * Both the dialog and the route call this, so what the operator approves on
 * screen and what the server writes cannot drift apart.
 */
export function importVerdict(prior: PriorStatus | undefined): { import: boolean; reason?: string } {
  if (prior === "unsubscribed") return { import: false, reason: "opted out here before; they must opt in again" };
  if (prior === "subscribed") return { import: false, reason: "already subscribed" };
  if (prior === "bounced") return { import: false, reason: "previous hard bounce" };
  return { import: true };
}
