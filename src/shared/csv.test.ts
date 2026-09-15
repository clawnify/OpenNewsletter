import { describe, expect, it } from "vitest";
import {
  buildPreview,
  guessCsvMapping,
  importVerdict,
  isEmail,
  parseCsv,
  sniffDelimiter,
  stageImportRows,
} from "./csv";

/** Cell values only — most tests don't care which line a row came from. */
const cells = (text: string, opts?: Parameters<typeof parseCsv>[1]) =>
  parseCsv(text, opts).rows.map((r) => r.cells);

describe("parseCsv", () => {
  it("keeps a comma that lives inside a quoted name", () => {
    const t = parseCsv('email,first_name\nada@example.com,"Lovelace, Ada"\n');
    expect(cells('email,first_name\nada@example.com,"Lovelace, Ada"\n')).toEqual([
      ["ada@example.com", "Lovelace, Ada"],
    ]);
    expect(t.ragged).toBe(0);
  });

  it("keeps a newline that lives inside a quoted field", () => {
    expect(cells('email,note\nada@example.com,"line one\nline two"\n')).toEqual([
      ["ada@example.com", "line one\nline two"],
    ]);
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(cells('email,first_name\nada@example.com,"Ada ""The Countess"""\n')[0][1]).toBe(
      'Ada "The Countess"',
    );
  });

  it("does not let a bare quote swallow the rest of the file", () => {
    // 5" nail — a quote only opens a field, so this parses as data.
    const t = parseCsv('email,product\nada@example.com,5" nail\n');
    expect(t.unterminated).toBe(false);
    expect(cells('email,product\nada@example.com,5" nail\n')).toEqual([["ada@example.com", '5" nail']]);
  });

  it("reports an unclosed quote instead of silently eating every later row", () => {
    const t = parseCsv('email,note\nada@example.com,"never closed\nbob@example.com,x\n');
    expect(t.unterminated).toBe(true);
    expect(t.rows.length).toBe(1);
  });

  it("strips the BOM Excel writes, so the first header still matches", () => {
    const t = parseCsv("\ufeffemail,first_name\nada@example.com,Ada\n");
    expect(t.headers).toEqual(["email", "first_name"]);
    expect(guessCsvMapping(t.headers)[0]).toBe("email");
  });

  it("handles CRLF and a lone CR as row endings", () => {
    expect(cells("email,first_name\r\nada@example.com,Ada\r\n")).toEqual([["ada@example.com", "Ada"]]);
    expect(cells("email,first_name\rada@example.com,Ada\r")).toEqual([["ada@example.com", "Ada"]]);
  });

  it("counts blank lines rather than turning them into contacts", () => {
    const t = parseCsv("email\nada@example.com\n\n\nbob@example.com\n");
    expect(t.blanks).toBe(2);
    expect(t.rows.map((r) => r.cells)).toEqual([["ada@example.com"], ["bob@example.com"]]);
  });

  it("treats an all-empty row like a blank line, not an invalid contact", () => {
    // `,,,` is a spacer in the file; reporting it as "no email address" would
    // make every export with a gap look like it had a bad row in it.
    const t = parseCsv("email,first_name\nada@example.com,Ada\n,,\nbob@example.com,Bob\n");
    expect(t.blanks).toBe(1);
    expect(t.rows.length).toBe(2);
  });

  it("counts ragged rows, which usually mean the delimiter was guessed wrong", () => {
    const t = parseCsv("email,first_name\nada@example.com,Ada,extra\nbob@example.com\n");
    expect(t.ragged).toBe(2);
    // Padded and truncated to the header, so the preview stays aligned.
    expect(t.rows.map((r) => r.cells)).toEqual([
      ["ada@example.com", "Ada"],
      ["bob@example.com", ""],
    ]);
  });

  it("invents header names when the file has no header row", () => {
    const t = parseCsv("ada@example.com,Ada\nbob@example.com,Bob\n", { has_header: false });
    expect(t.headers).toEqual(["Column 1", "Column 2"]);
    expect(t.rows.length).toBe(2);
  });

  it("names a genuinely empty header column so it can still be mapped", () => {
    expect(parseCsv("email,,first_name\nada@example.com,x,Ada\n").headers).toEqual([
      "email",
      "Column 2",
      "first_name",
    ]);
  });

  it("numbers rows by source line, so a quoted newline doesn't shift them", () => {
    // The quoted field spans lines 2-3, so bob is on line 4 — not row 2.
    const t = parseCsv('email,note\nada@example.com,"a\nb"\nbob@example.com,x\n');
    expect(t.rows.map((r) => r.line)).toEqual([2, 4]);
  });
});

describe("sniffDelimiter", () => {
  it("recognises the alternatives exports actually use", () => {
    expect(sniffDelimiter("email;first_name\nada@example.com;Ada\n")).toBe(";");
    expect(sniffDelimiter("email\tfirst_name\nada@example.com\tAda\n")).toBe("\t");
    expect(sniffDelimiter("email|first_name\nada@example.com|Ada\n")).toBe("|");
    expect(sniffDelimiter("email,first_name\nada@example.com,Ada\n")).toBe(",");
  });

  it("ignores a delimiter inside quotes when voting", () => {
    expect(sniffDelimiter('email;first_name\nada@example.com;"Lovelace, Ada"\n')).toBe(";");
  });

  it("falls back to a comma on an empty file instead of throwing", () => {
    expect(sniffDelimiter("")).toBe(",");
  });
});

describe("isEmail", () => {
  it("accepts the shapes that are mail-able", () => {
    expect(isEmail("ada@example.com")).toBe(true);
    expect(isEmail("ada+news@sub.example.co.uk")).toBe(true);
  });

  it("rejects the filler that contact exports are full of", () => {
    for (const bad of ["", "N/A", "n/a", "jane@doe", "not-an-email", "a b@example.com", "a@b.c", "jane@doe, jill@doe"]) {
      expect(isEmail(bad), bad).toBe(false);
    }
  });
});

describe("guessCsvMapping", () => {
  it("matches the header spellings real exports use", () => {
    expect(guessCsvMapping(["Email Address", "First Name", "Last Name"])).toEqual([
      "email",
      "first_name",
      "last_name",
    ]);
    expect(guessCsvMapping(["E-mail", "Given Name", "Surname"])).toEqual(["email", "first_name", "last_name"]);
  });

  it("leaves unknown columns alone rather than guessing wildly", () => {
    expect(guessCsvMapping(["Company", "Email", "Notes"])).toEqual(["ignore", "email", "ignore"]);
  });

  it("maps each field once, so a second 'email' column stays ignored", () => {
    expect(guessCsvMapping(["Email", "email"])).toEqual(["email", "ignore"]);
  });
});

describe("buildPreview", () => {
  // Row 3 is an all-empty spacer; it drops out of the file as a blank rather
  // than arriving here as a contact with no address.
  const table = parseCsv("email,first_name,last_name\nada@example.com,Ada,Lovelace\n,,\nN/A,Jo,Soap\n");

  it("reports that nothing can be imported until a column is mapped to email", () => {
    const p = buildPreview(table, ["ignore", "first_name", "ignore"]);
    expect(p.has_email).toBe(false);
    expect(p.candidates).toEqual([]);
  });

  it("separates importable rows from the ones that can never be mailed", () => {
    const p = buildPreview(table, ["email", "first_name", "last_name"]);
    expect(p.candidates).toEqual([
      { line: 2, email: "ada@example.com", first_name: "Ada", last_name: "Lovelace" },
    ]);
    expect(p.invalid).toEqual([{ line: 4, email: "N/A", reason: "not an email address" }]);
  });

  it("collapses case and surrounds, so the same person is one row", () => {
    const dupes = parseCsv("email,name\nAda@Example.com ,Ada\nada@example.com,Ada again\n");
    const p = buildPreview(dupes, ["email", "ignore"]);
    expect(p.candidates.length).toBe(1);
    expect(p.candidates[0].email).toBe("ada@example.com");
    expect(p.duplicates).toEqual([{ line: 3, email: "ada@example.com" }]);
  });

  it("collapses whitespace inside names and drops the rest", () => {
    const messy = parseCsv('email,first_name\nada@example.com,"  Ada   King  "\n');
    expect(buildPreview(messy, ["email", "first_name"]).candidates[0].first_name).toBe("Ada King");
  });

  it("imports on the address alone when no name column is mapped", () => {
    const p = buildPreview(table, ["email", "ignore", "ignore"]);
    expect(p.candidates[0]).toEqual({
      line: 2,
      email: "ada@example.com",
      first_name: "",
      last_name: "",
    });
  });

  it("survives a mapping shorter or longer than the header", () => {
    // Guards the dialog, where a mapping array can briefly be out of step with
    // the table after the operator re-reads the file with another delimiter.
    expect(buildPreview(table, ["email"]).candidates.length).toBe(1);
    expect(buildPreview(table, ["email", "first_name", "last_name", "ignore"]).candidates.length).toBe(1);
  });
});

describe("stageImportRows", () => {
  it("re-validates what was posted, since the server never sees the file", () => {
    const { rows, invalid } = stageImportRows([
      { email: "ada@example.com", first_name: "Ada" },
      { email: "N/A" },
      { email: "ada@example.com" },
      "junk",
      { email: "bob@example.com" },
    ]);
    expect(rows.map((r) => r.email)).toEqual(["ada@example.com", "bob@example.com"]);
    expect(invalid.map((i) => i.reason)).toEqual([
      "not an email address",
      "duplicate address",
      "malformed row",
    ]);
    // Positions stand in for lines when the client didn't send one.
    expect(invalid.map((i) => i.line)).toEqual([2, 3, 4]);
  });

  it("keeps the source line the browser sent, so a rejection is findable", () => {
    const { rows, invalid } = stageImportRows([
      { line: 2, email: "ada@example.com" },
      { line: 9, email: "nope" },
    ]);
    expect(rows[0].line).toBe(2);
    expect(invalid[0].line).toBe(9);
  });

  it("ignores a nonsense line value rather than trusting it", () => {
    const { rows } = stageImportRows([
      { line: -4, email: "ada@example.com" },
      { line: "x", email: "bob@example.com" },
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 2]);
  });

  it("treats a non-array body as an empty import", () => {
    expect(stageImportRows(null).rows).toEqual([]);
    expect(stageImportRows("nope").rows).toEqual([]);
  });
});

describe("importVerdict", () => {
  it("imports someone who is not on the list, or only pending", () => {
    expect(importVerdict(undefined)).toEqual({ import: true });
    expect(importVerdict("pending")).toEqual({ import: true });
  });

  it("never re-imports someone who opted out", () => {
    const v = importVerdict("unsubscribed");
    expect(v.import).toBe(false);
    expect(v.reason).toContain("opt in again");
  });

  it("leaves an existing subscriber's record alone", () => {
    const v = importVerdict("subscribed");
    expect(v.import).toBe(false);
    // Importing over them would replace their evidence with a row from a file.
    expect(v.reason).toContain("already subscribed");
  });

  it("stops a hard bounce being mailed again", () => {
    expect(importVerdict("bounced").import).toBe(false);
  });
});
