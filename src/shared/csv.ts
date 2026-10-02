/**
 * CSV in and out, for subscriber import and export. Shared so the browser can
 * parse a file before anything is uploaded and the server tests the same code.
 *
 * Parsing follows RFC 4180 (quoted fields, "" inside quotes, line breaks inside
 * quotes, CRLF or LF) plus what real exports carry: a UTF-8 byte order mark,
 * and `;` or tab as the separator (Excel in many European locales saves `;`).
 */

export type Delimiter = "," | ";" | "\t";

/** The separator the header line uses most, counting only outside quotes. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && (ch === "," || ch === ";" || ch === "\t")) counts[ch]++;
  }
  return (Object.keys(counts) as Delimiter[]).reduce((best, d) => (counts[d] > counts[best] ? d : best), ",");
}

/** Rows of fields. Blank lines are dropped. */
export function parseCsv(input: string, delimiter: Delimiter = detectDelimiter(input.replace(/^﻿/, ""))): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0].trim() !== "") rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else field += ch;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/** One CSV line. Quotes a field only when it needs it. */
function line(fields: (string | number | null | undefined)[]): string {
  return fields
    .map((v) => {
      let s = v == null ? "" : String(v);
      // A leading = + - @ makes spreadsheets run the cell as a formula.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [line(header), ...rows.map(line)].join("\r\n") + "\r\n";
}
