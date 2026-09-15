/**
 * How the audience list narrows down: search, date-added range, ordering.
 *
 * Shared by the browser and the worker because the two must agree about what a
 * filter *means*. If the client built its own query string and the worker
 * interpreted it slightly differently, the count shown to the reader ("1–50 of
 * 812") would describe a different set of rows than the ones listed. One
 * module, one interpretation.
 *
 * The SQL fragments here are deliberately assembled from constants with bound
 * parameters — nothing from the request is ever interpolated into SQL. See
 * `contactQuery`, the only place the WHERE clause is built.
 */

/** Rows per page. Also the number the audience list shows on first load. */
export const CONTACT_PAGE_SIZE = 50;

/** Ceiling on `?limit=`, so a hand-written request cannot ask for everything. */
export const CONTACT_MAX_PAGE_SIZE = 200;

export type ContactSort = "date_desc" | "date_asc" | "name_asc" | "name_desc";

export const CONTACT_SORTS = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
] as const satisfies readonly { value: ContactSort; label: string }[];

export function isContactSort(value: unknown): value is ContactSort {
  return typeof value === "string" && CONTACT_SORTS.some((s) => s.value === value);
}

/**
 * A person's display name, as an SQL expression.
 *
 * `first_name` and `last_name` are NOT NULL but default to `''`, and someone
 * with only a last name would otherwise sort on a leading space, which puts
 * them above every real name. `trim` collapses that. Rows with neither name
 * sort together at the top — they are email-only contacts, and the tiebreaker
 * below keeps that group in a stable order.
 */
const CONTACT_NAME_SQL = "trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))";

/**
 * The calendar day part of `created_at`.
 *
 * `created_at` arrives in two shapes: SQLite's own default
 * (`"2026-09-15 14:32:07"`, space-separated, second precision) for rows that
 * let the column default apply, and ISO strings written by the app
 * (`"2026-09-15T14:32:07.123Z"`). Comparing raw values against a time bound
 * silently breaks across the two — `" " < "T"`, so every default-format row
 * sorts before the start of its own day and a "from today" filter drops all of
 * them.
 *
 * The first ten characters are `YYYY-MM-DD` in both formats, so filtering on
 * the date part is both format-agnostic and exactly the question a date filter
 * asks ("which day was this added"). A NULL `created_at` yields NULL and so
 * cannot match — an undated row is not "added on" any day.
 */
const CONTACT_DAY_SQL = "substr(created_at, 1, 10)";

/**
 * Matches a search term against the fields a reader would actually type.
 *
 * `ESCAPE` so a literal `%` or `_` in a name matches itself instead of acting
 * as a wildcard. The two reversed-name forms let someone find "Okonkwo Amara"
 * by typing the surname first, which is how most people scan a subscriber list.
 */
const CONTACT_SEARCH_SQL = `(
      email LIKE ? ESCAPE '\\'
   OR coalesce(first_name, '') LIKE ? ESCAPE '\\'
   OR coalesce(last_name, '') LIKE ? ESCAPE '\\'
   OR ${CONTACT_NAME_SQL} LIKE ? ESCAPE '\\'
   OR trim(coalesce(last_name, '') || ' ' || coalesce(first_name, '')) LIKE ? ESCAPE '\\'
)`;

/** Every search term is bound five times, once per column above. */
const SEARCH_PARAM_COUNT = 5;

/**
 * Neutralise LIKE's own wildcards in reader input.
 *
 * Without this, searching for `_` matches every row (single-character
 * wildcard), and a name like `100%` becomes a pattern. One pass with a
 * function, so the backslashes this inserts are never themselves re-escaped.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Accepts `YYYY-MM-DD` (what `<input type="date">` submits) and returns it
 * unchanged; anything else becomes `""`, meaning "no filter on this side".
 *
 * Rejects impossible days rather than rolling them over: `Date.UTC` turns
 * `2026-02-31` into March 3, so the parsed date is compared back against the
 * digits actually given. Only the year/month/day fields are checked — the
 * format comparison itself stays a plain string compare, which is valid
 * because `YYYY-MM-DD` is zero-padded and therefore sorts by date.
 */
export function normalizeDay(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  const m = DAY.exec(raw);
  if (!m) return "";

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(probe.getTime())) return "";
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return "";
  }
  return raw;
}

export interface ContactFilters {
  search?: string;
  /** Inclusive `YYYY-MM-DD` lower bound on created_at. */
  from?: string;
  /** Inclusive `YYYY-MM-DD` upper bound on created_at. */
  to?: string;
  sort?: ContactSort;
}

export interface ContactQueryParts {
  /** WHERE clause, already parenthesised per-term. Binds `params` in order. */
  where: string;
  params: string[];
  orderBy: string;
}

/**
 * ORDER BY for a sort choice.
 *
 * Every branch ends in `id`, which is unique. Without it the order is
 * undefined between rows sharing a `created_at` — and `created_at` has
 * **second** precision, so a bulk import produces whole runs of identical
 * values. SQLite is then free to return those rows in a different order per
 * query, which under LIMIT/OFFSET means one row appears on two pages while
 * another never appears at all. The tiebreaker is what makes paging correct,
 * not a nicety.
 *
 * `COLLATE NOCASE` matches the case-insensitive search: SQLite's default
 * BINARY collation would sort every capitalised name above every lowercase
 * one, so "Zoe" would come before "alice".
 */
export function contactOrderBy(sort: ContactSort = "date_desc"): string {
  switch (sort) {
    case "date_asc":
      return `created_at ASC, id ASC`;
    case "name_asc":
      return `${CONTACT_NAME_SQL} COLLATE NOCASE ASC, created_at DESC, id DESC`;
    case "name_desc":
      return `${CONTACT_NAME_SQL} COLLATE NOCASE DESC, created_at DESC, id DESC`;
    default:
      return `created_at DESC, id DESC`;
  }
}

/**
 * Build the WHERE/ORDER BY for a filtered contact list.
 *
 * Always scoped to one audience — `where` starts with `audience_id = ?` and
 * `params[0]` is the audience id, so a caller cannot accidentally drop the
 * scope and read another list's contacts.
 */
export function contactQuery(audienceId: string, filters: ContactFilters = {}): ContactQueryParts {
  const where = ["audience_id = ?"];
  const params = [audienceId];

  const term = (filters.search ?? "").trim();
  if (term) {
    where.push(CONTACT_SEARCH_SQL);
    const pattern = `%${escapeLike(term)}%`;
    for (let i = 0; i < SEARCH_PARAM_COUNT; i++) params.push(pattern);
  }

  const from = normalizeDay(filters.from);
  const to = normalizeDay(filters.to);
  if (from) {
    where.push(`${CONTACT_DAY_SQL} >= ?`);
    params.push(from);
  }
  if (to) {
    where.push(`${CONTACT_DAY_SQL} <= ?`);
    params.push(to);
  }

  return { where: where.join(" AND "), params, orderBy: contactOrderBy(filters.sort) };
}

export interface ContactQueryArgs {
  search: string;
  from: string;
  to: string;
  sort: ContactSort;
  page: number;
  limit: number;
}

/**
 * Read the query string the audience list sends.
 *
 * Tolerant by design: a nonsense `?page=abc` or an impossible date falls back
 * to the default rather than erroring, because a malformed URL someone pasted
 * should show the list, not a stack trace. `limit` is clamped so the cap cannot
 * be bypassed, and the parsed values here are what `contactQuery` then treats
 * as trusted — the only filters that reach SQL.
 */
export function parseContactQuery(sp: URLSearchParams): ContactQueryArgs {
  const page = Number(sp.get("page"));
  const limit = Number(sp.get("limit"));
  const sort = sp.get("sort");

  return {
    search: (sp.get("search") ?? "").trim(),
    from: normalizeDay(sp.get("from")),
    to: normalizeDay(sp.get("to")),
    sort: isContactSort(sort) ? sort : "date_desc",
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    limit:
      Number.isFinite(limit) && limit >= 1
        ? Math.min(Math.floor(limit), CONTACT_MAX_PAGE_SIZE)
        : CONTACT_PAGE_SIZE,
  };
}
