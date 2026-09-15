import { describe, expect, it } from "vitest";
import {
  CONTACT_MAX_PAGE_SIZE,
  CONTACT_PAGE_SIZE,
  contactOrderBy,
  contactQuery,
  escapeLike,
  isContactSort,
  normalizeDay,
  parseContactQuery,
} from "./contact-query";

describe("normalizeDay", () => {
  it("accepts the format a date input submits", () => {
    expect(normalizeDay("2026-09-15")).toBe("2026-09-15");
  });

  it("trims surrounding whitespace rather than rejecting it", () => {
    expect(normalizeDay("  2026-09-15 ")).toBe("2026-09-15");
  });

  it("treats empty and missing as no filter", () => {
    expect(normalizeDay("")).toBe("");
    expect(normalizeDay(null)).toBe("");
    expect(normalizeDay(undefined)).toBe("");
  });

  it.each(["2026-9-15", "15/09/2026", "2026-09-15T00:00:00Z", "yesterday", "2026-09"])(
    "rejects %s, which is not a plain day",
    (input) => {
      expect(normalizeDay(input)).toBe("");
    },
  );

  // The reason this function compares the parsed date back against the digits:
  // Date.UTC happily rolls 31 February over into March, so a naive parse would
  // accept a day that does not exist and filter on the wrong date.
  it("rejects a day that does not exist instead of rolling it forward", () => {
    expect(normalizeDay("2026-02-31")).toBe("");
    expect(normalizeDay("2026-02-30")).toBe("");
    expect(normalizeDay("2025-02-29")).toBe("");
    expect(normalizeDay("2026-04-31")).toBe("");
  });

  it("keeps a real leap day", () => {
    expect(normalizeDay("2024-02-29")).toBe("2024-02-29");
  });

  it("rejects an out-of-range month", () => {
    expect(normalizeDay("2026-13-01")).toBe("");
    expect(normalizeDay("2026-00-10")).toBe("");
  });
});

describe("escapeLike", () => {
  // Without this, `?search=_` matches every row, because `_` is LIKE's
  // single-character wildcard.
  it("escapes the wildcards so they match literally", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
  });

  it("escapes a backslash so it cannot alter an escape sequence", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeLike("Priya Raman")).toBe("Priya Raman");
    expect(escapeLike("O'Brien")).toBe("O'Brien");
  });

  // A replace-all with a callback, so the backslashes this adds are not then
  // re-escaped by a later pass.
  it("does not double-escape what it just inserted", () => {
    expect(escapeLike("%_")).toBe("\\%\\_");
  });
});

describe("contactOrderBy", () => {
  // `created_at` has second precision, so a bulk import produces runs of rows
  // with an identical value. Without a unique tiebreaker SQLite may return
  // those rows in a different order per query — which under LIMIT/OFFSET makes
  // one row appear on two pages and another never appear at all.
  it.each(["date_desc", "date_asc", "name_asc", "name_desc"] as const)(
    "ends %s in the unique id, so paging is stable",
    (sort) => {
      expect(contactOrderBy(sort).trimEnd()).toMatch(/id (ASC|DESC)$/);
    },
  );

  // Default BINARY collation sorts every capitalised name above every lowercase
  // one, putting "Zoe" before "alice".
  it("sorts names case-insensitively", () => {
    expect(contactOrderBy("name_asc")).toContain("COLLATE NOCASE ASC");
    expect(contactOrderBy("name_desc")).toContain("COLLATE NOCASE DESC");
  });

  it("defaults to newest first", () => {
    expect(contactOrderBy()).toBe(contactOrderBy("date_desc"));
  });
});

describe("contactQuery", () => {
  it("always scopes to the audience", () => {
    const { where, params } = contactQuery("aud_1");
    expect(where).toBe("audience_id = ?");
    expect(params).toEqual(["aud_1"]);
  });

  it("adds no clauses when nothing is filtered", () => {
    const { where, params } = contactQuery("aud_1", { search: "  ", from: "", to: "" });
    expect(where).toBe("audience_id = ?");
    expect(params).toEqual(["aud_1"]);
  });

  it("binds one parameter per searched column, never the raw term", () => {
    const { where, params } = contactQuery("aud_1", { search: "priya" });
    expect(params).toEqual(["aud_1", "%priya%", "%priya%", "%priya%", "%priya%", "%priya%"]);
    expect(where).not.toContain("priya");
  });

  // The contract that makes this module worth having: the text in a URL and the
  // text in SQL never touch. A term carrying SQL is just a bound parameter.
  it("treats a hostile search term as data, not SQL", () => {
    const hostile = "%' OR 1=1 --";
    const { where, params } = contactQuery("aud_1", { search: hostile });
    expect(where).not.toContain("OR 1=1");
    expect(where).not.toContain(hostile);
    expect(params[1]).toBe(`%${escapeLike(hostile)}%`);
    expect(params[1]).toContain("\\%");
  });

  it("filters a date range with both bounds inclusive", () => {
    const { where, params } = contactQuery("aud_1", { from: "2026-01-01", to: "2026-01-31" });
    expect(params).toEqual(["aud_1", "2026-01-01", "2026-01-31"]);
    expect(where).toContain(">= ?");
    expect(where).toContain("<= ?");
  });

  it("filters on the date part of created_at, so both stored formats behave alike", () => {
    const { where } = contactQuery("aud_1", { from: "2026-01-01" });
    expect(where).toContain("substr(created_at, 1, 10)");
    // Comparing the raw column would drop every row that took SQLite's
    // space-separated default, because " " sorts before "T".
    expect(where).not.toMatch(/[^)]created_at >=/);
  });

  it("ignores an unparseable date rather than filtering on nothing", () => {
    const { where, params } = contactQuery("aud_1", { from: "not-a-date" });
    expect(where).toBe("audience_id = ?");
    expect(params).toEqual(["aud_1"]);
  });

  it("combines search and dates, keeping audience_id first", () => {
    const { where, params } = contactQuery("aud_1", { search: "a", from: "2026-01-01", to: "2026-12-31" });
    expect(params.slice(0, 1)).toEqual(["aud_1"]);
    expect(params).toHaveLength(8);
    expect(where.startsWith("audience_id = ?")).toBe(true);
    // Each term is parenthesised: an OR left ungrouped would bind loosely
    // against the ANDs and widen the audience scope to every list.
    expect(where).toContain("(");
  });

  it("keeps the audience scope grouped so a search cannot widen it", () => {
    const { where } = contactQuery("aud_1", { search: "x" });
    expect(where).toMatch(/^audience_id = \? AND \(/);
  });
});

describe("isContactSort", () => {
  it("accepts the known sorts", () => {
    expect(isContactSort("name_asc")).toBe(true);
  });

  it.each([undefined, null, "", "date", "created_at DESC", 1])("rejects %s", (v) => {
    expect(isContactSort(v)).toBe(false);
  });
});

describe("parseContactQuery", () => {
  const parse = (qs: string) => parseContactQuery(new URLSearchParams(qs));

  it("defaults to the newest 50 of an unfiltered list", () => {
    expect(parse("")).toEqual({
      search: "",
      from: "",
      to: "",
      sort: "date_desc",
      page: 1,
      limit: CONTACT_PAGE_SIZE,
    });
  });

  it("reads the filters the audience list sends", () => {
    expect(parse("search=Priya&from=2026-01-01&to=2026-03-31&sort=name_asc&page=3")).toEqual({
      search: "Priya",
      from: "2026-01-01",
      to: "2026-03-31",
      sort: "name_asc",
      page: 3,
      limit: CONTACT_PAGE_SIZE,
    });
  });

  it("trims a search term so a trailing space is not a different query", () => {
    expect(parse("search=%20Priya%20").search).toBe("Priya");
  });

  // A pasted or hand-edited URL should show the list, not an error page.
  it.each([
    ["page=abc"],
    ["page=0"],
    ["page=-4"],
    ["page=1.5"],
  ])("falls back to page 1 for %s", (qs) => {
    expect(parse(qs).page).toBe(1);
  });

  it("falls back for an unknown sort instead of passing it to SQL", () => {
    expect(parse("sort=DROP TABLE contacts").sort).toBe("date_desc");
  });

  it("drops an impossible date rather than filtering on a rolled-over day", () => {
    expect(parse("from=2026-02-31").from).toBe("");
  });

  // The cap is enforced here, on the only path that reaches SQL, so a
  // hand-written request cannot ask for the whole table.
  it("clamps limit to the maximum", () => {
    expect(parse("limit=100000").limit).toBe(CONTACT_MAX_PAGE_SIZE);
    expect(parse("limit=25").limit).toBe(25);
  });

  it.each(["limit=0", "limit=-1", "limit=abc", "limit="])("uses the default page size for %s", (qs) => {
    expect(parse(qs).limit).toBe(CONTACT_PAGE_SIZE);
  });

  // The point of sharing this module: whatever the client puts in a URL, the
  // worker's SQL binds it rather than embedding it.
  it("round-trips a hostile URL into bound parameters", () => {
    const args = parse(`search=${encodeURIComponent("%' OR 1=1 --")}&limit=100000`);
    const { where, params } = contactQuery("aud_1", {
      search: args.search,
      from: args.from,
      to: args.to,
      sort: args.sort,
    });
    expect(args.limit).toBe(CONTACT_MAX_PAGE_SIZE);
    expect(where).not.toContain("OR 1=1");
    expect(params.every((p) => typeof p === "string")).toBe(true);
  });
});
