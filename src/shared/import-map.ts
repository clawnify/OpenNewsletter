/**
 * Map a CSV export from another newsletter platform onto subscriber rows.
 * Pure, shared by the import dialog (which shows the mapping before anything
 * is sent) and the tests.
 *
 * Vendors document what their exports contain but mostly not the literal
 * headers (checked 2026-10-02: only Ghost and Buttondown publish them), and
 * the headers follow the account's own field labels. So nothing here is keyed
 * on one vendor's spelling: columns and status values are guessed from
 * synonyms, and the dialog shows both guesses for the operator to correct.
 * Mailchimp says status by which file a row is in (subscribed, unsubscribed,
 * non-subscribed, cleaned), so a file name can set the status for every row.
 */

export type ImportStatus = "subscribed" | "pending" | "unsubscribed" | "bounced";
/** What the operator maps a status value (or a whole file) to. */
export type StatusChoice = ImportStatus | "skip";

export interface ImportRow {
  email: string;
  first_name: string;
  last_name: string;
  status: ImportStatus;
  /** When they opted in on the old platform, if the export says (ISO). */
  opted_in_at: string | null;
  /** Per-row consent record (this app's own export carries one). */
  evidence?: string;
}

export const FIELDS = ["email", "first_name", "last_name", "name", "status", "opted_in_at", "evidence"] as const;
export type Field = (typeof FIELDS)[number];
/** Column index per field; -1 = not in the file. */
export type ColumnMap = Record<Field, number>;

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Most specific first: the first alias found in the header wins.
const ALIASES: Record<Field, string[]> = {
  email: ["email", "emailaddress", "subscriberemail", "email1", "mail", "emailadres", "eposta"],
  first_name: ["firstname", "fname", "givenname", "first", "voornaam", "nome"],
  last_name: ["lastname", "lname", "surname", "familyname", "last", "achternaam", "cognome"],
  name: ["name", "fullname", "displayname", "subscribername"],
  status: ["status", "subscribertype", "subscriptionstatus", "subscribedtoemails", "state", "emailstatus", "subscribed"],
  opted_in_at: [
    "consentat", "confirmtime", "optintime", "subscriptiondate", "subscribedat", "subscribeddate",
    "createdat", "createddate", "createddateandtime", "creationdate", "dateadded", "created", "signupdate",
  ],
  evidence: ["consentevidence"],
};

export function guessColumns(header: string[]): ColumnMap {
  const keys = header.map(key);
  const map = {} as ColumnMap;
  const used = new Set<number>();
  for (const f of FIELDS) {
    map[f] = -1;
    for (const alias of ALIASES[f]) {
      const i = keys.findIndex((k, idx) => k === alias && !used.has(idx));
      if (i >= 0) {
        map[f] = i;
        used.add(i);
        break;
      }
    }
  }
  // No header called "email": the first column whose name contains it.
  if (map.email < 0) {
    const i = keys.findIndex((k, idx) => k.includes("email") && !used.has(idx));
    if (i >= 0) map.email = i;
  }
  return map;
}

const STATUS_WORDS: [StatusChoice, string[]][] = [
  // Checked in this order: "unsubscribed" contains "subscribed".
  ["bounced", ["bounced", "cleaned", "undeliverable", "complained", "blocked", "spam", "hardbounce", "invalid"]],
  ["unsubscribed", ["unsubscribed", "inactive", "cancelled", "canceled", "churned", "optedout", "optout", "removed", "false", "no", "0"]],
  ["skip", ["nonsubscribed", "transactional", "archived", "deleted"]],
  ["pending", ["pending", "unconfirmed", "unactivated", "needsapproval", "validating", "paused"]],
  [
    "subscribed",
    ["subscribed", "active", "confirmed", "regular", "premium", "paid", "free", "comp", "gifted", "gift", "trialed",
      "founding", "cold", "churning", "pastdue", "unpaid", "true", "yes", "1"],
  ],
];

/** Best guess for one status value. Unknown values are `pending`: never mailed until someone decides. */
export function guessStatus(value: string): StatusChoice {
  const k = key(value);
  if (!k) return "subscribed"; // a blank status column usually means "on the list"
  for (const [choice, words] of STATUS_WORDS) if (words.includes(k)) return choice;
  return "pending";
}

/** Status every row of a file has, read from a Mailchimp-style file name; null = read it per row. */
export function statusFromFileName(name: string): StatusChoice | null {
  const k = key(name);
  if (k.includes("unsubscribed")) return "unsubscribed";
  if (k.includes("cleaned")) return "bounced";
  if (k.includes("nonsubscribed")) return "skip";
  if (k.includes("subscribed")) return "subscribed";
  return null;
}

/** Distinct values of the status column, most common first. */
export function statusValues(rows: string[][], col: number): { value: string; count: number }[] {
  if (col < 0) return [];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = (r[col] ?? "").trim();
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

/**
 * Opt-in timestamp as ISO, or null. A date-time with no zone ("2024-03-01
 * 09:30:00", how most exports write it) is read as UTC, not as the browser's
 * local time.
 */
export function parseDate(value: string): string | null {
  let v = value.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v = `${v.replace(" ", "T")}Z`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v = `${v}T00:00:00Z`;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** A spreadsheet-safe cell from our own export ('=…) back to its value. */
const unguard = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

export interface Mapped {
  rows: ImportRow[];
  /** Rows dropped because their status maps to "skip". */
  skipped: number;
}

export function mapRows(
  rows: string[][],
  cols: ColumnMap,
  status: { file: StatusChoice | null; values: Record<string, StatusChoice> },
): Mapped {
  const out: ImportRow[] = [];
  let skipped = 0;
  const cell = (r: string[], i: number) => (i >= 0 ? unguard((r[i] ?? "").trim()) : "");
  for (const r of rows) {
    const choice = status.file ?? (cols.status >= 0 ? (status.values[(r[cols.status] ?? "").trim()] ?? guessStatus(r[cols.status] ?? "")) : "subscribed");
    if (choice === "skip") {
      skipped++;
      continue;
    }
    let first = cell(r, cols.first_name);
    let last = cell(r, cols.last_name);
    if (!first && !last && cols.name >= 0) {
      const full = cell(r, cols.name);
      const sp = full.indexOf(" ");
      first = sp > 0 ? full.slice(0, sp) : full;
      last = sp > 0 ? full.slice(sp + 1).trim() : "";
    }
    const row: ImportRow = {
      email: cell(r, cols.email),
      first_name: first,
      last_name: last,
      status: choice,
      opted_in_at: parseDate(cell(r, cols.opted_in_at)),
    };
    const ev = cell(r, cols.evidence);
    if (ev) row.evidence = ev;
    out.push(row);
  }
  return { rows: out, skipped };
}
