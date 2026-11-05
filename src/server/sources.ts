/**
 * Sources: what the publication's issues are grounded on. GitHub repos today,
 * whose recent commits become changelog copy.
 *
 * They live in Settings and every source there is always included: the in-app
 * assistant (outside Clawnify) gets their recent activity in its prompt, and
 * the Clawnify sidebar chat gets it in GET /api/mails/:id/context, the one read
 * it makes before editing an issue. The sidebar chat has no source picker of
 * its own, so a per-chat choice would not reach it; a setting does.
 */
import type { Source } from "../shared/types";

/** At most this many sources, so one context read stays a bounded number of GitHub calls. */
export const MAX_SOURCES = 10;
const RECENT_DAYS = 7;

const ghHeaders = (token?: string): Record<string, string> => ({
  "User-Agent": "open-newsletter",
  Accept: "application/vnd.github+json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

export const cleanSlug = (repo: string) => repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
const isSlug = (slug: string) => /^[\w.-]+\/[\w.-]+$/.test(slug);

/** Settings input to a clean, deduplicated list. Anything that isn't a GitHub owner/name is dropped. */
export function cleanSources(input: unknown): Source[] {
  if (!Array.isArray(input)) return [];
  const out: Source[] = [];
  for (const s of input) {
    if (!s || typeof s !== "object" || (s as Source).kind !== "github") continue;
    const repo = cleanSlug(String((s as Source).repo || ""));
    if (isSlug(repo) && !out.some((o) => o.repo.toLowerCase() === repo.toLowerCase())) out.push({ kind: "github", repo });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

function commitLines(items: Array<{ commit?: { message?: string; author?: { date?: string } } }>): string[] {
  return items
    .map((c) => {
      const subject = (c.commit?.message || "").split("\n")[0];
      const date = (c.commit?.author?.date || "").slice(0, 10);
      return subject ? `${subject}${date ? ` (${date})` : ""}` : "";
    })
    .filter(Boolean);
}

export type SourceActivity = { kind: "github"; repo: string; recent_commits: string[]; error?: string };

/** Commit subjects from the last week in each source. A source GitHub refuses reports why instead of failing the rest. */
export async function recentActivity(sources: Source[], token?: string): Promise<SourceActivity[]> {
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString();
  return Promise.all(
    sources.map(async (s): Promise<SourceActivity> => {
      try {
        const r = await fetch(`https://api.github.com/repos/${s.repo}/commits?per_page=40&since=${since}`, { headers: ghHeaders(token) });
        if (!r.ok) return { ...s, recent_commits: [], error: `GitHub answered ${r.status}${r.status === 404 && !token ? " (a private repo needs GITHUB_TOKEN)" : ""}` };
        return { ...s, recent_commits: commitLines((await r.json()) as Parameters<typeof commitLines>[0]) };
      } catch {
        return { ...s, recent_commits: [], error: "GitHub could not be reached" };
      }
    }),
  );
}

/** The activity as prompt text, for the in-app assistant. Empty when nothing happened. */
export function activityText(activity: SourceActivity[]): string {
  const blocks = activity
    .filter((a) => a.recent_commits.length)
    .map((a) => `Recent commits in ${a.repo} (last ${RECENT_DAYS} days):\n${a.recent_commits.map((l) => `- ${l}`).join("\n")}`);
  if (!blocks.length) return "";
  return `\n\nSOURCES (from Settings, always included) with recent activity, use as factual grounding (e.g. turn commits into a changelog):\n${blocks.join("\n\n")}`;
}

/** Search commit messages in one source. */
export async function searchCommits(repo: string, query: string, token?: string): Promise<{ ok: true; commits: string[] } | { ok: false; error: string }> {
  const q = encodeURIComponent(`repo:${repo} ${query}`);
  try {
    const r = await fetch(`https://api.github.com/search/commits?q=${q}&per_page=20`, { headers: ghHeaders(token) });
    if (!r.ok) return { ok: false, error: `GitHub search failed (${r.status}).` };
    const data = (await r.json()) as { items?: Parameters<typeof commitLines>[0] };
    return { ok: true, commits: commitLines(data.items || []) };
  } catch {
    return { ok: false, error: "GitHub could not be reached." };
  }
}
