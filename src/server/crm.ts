// Import from a CRM that lives in the same workspace.
//
// When this app is installed as part of a bundle next to a CRM, the platform
// sets CRM_APP_ID. The CRM stays the system of record for the *person*; this
// app stays the system of record for *consent and membership*. So nothing here
// reads CRM rows into sends directly: the operator picks contacts, states how
// consent was obtained, and only then do they become subscribers, keyed back
// to the CRM by id. Without CRM_APP_ID every function reports "not connected"
// and the rest of the app behaves as a single install.

export interface CrmEnv {
  CRM_APP_ID?: string;
  CLAWNIFY_TOKEN?: string;
}

export interface CrmContact {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  company_name?: string | null;
  title?: string;
  status?: string;
}

export interface CrmPage {
  contacts: CrmContact[];
  total: number;
  page: number;
  limit: number;
}

/** Bounded so one import cannot fan out into thousands of proxied reads. */
export const MAX_IMPORT = 200;

export function crmConfigured(env: CrmEnv): boolean {
  return !!env.CRM_APP_ID?.trim() && !!env.CLAWNIFY_TOKEN?.trim();
}

/** The sibling app is reached through the platform proxy, never by hostname. */
export function crmProxyUrl(appId: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `https://provision.clawnify.com/v1/apps/${encodeURIComponent(appId)}/proxy${p}`;
}

/**
 * Evidence is the one field that turns a CRM row into a subscriber, so it is
 * validated here rather than trusted from the form: short strings like "ok"
 * are exactly the non-evidence that makes a list indefensible.
 */
export function validateEvidence(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  return t.length >= 12 ? t : null;
}

export function pickIds(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const ids = input.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (ids.length === 0 || ids.length > MAX_IMPORT) return null;
  return Array.from(new Set(ids.map((v) => v.trim())));
}

async function crmFetch<T>(env: CrmEnv, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(crmProxyUrl(env.CRM_APP_ID!, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLAWNIFY_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const msg = (data as { error?: string }).error || `CRM request failed (${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}

export async function listCrmContacts(
  env: CrmEnv,
  opts: { page?: number; limit?: number; search?: string; status?: string } = {},
): Promise<CrmPage> {
  const q = new URLSearchParams();
  q.set("page", String(opts.page ?? 1));
  q.set("limit", String(Math.min(opts.limit ?? 50, 100)));
  if (opts.search) q.set("search", opts.search);
  if (opts.status) q.set("status", opts.status);
  return crmFetch<CrmPage>(env, `/api/contacts?${q.toString()}`);
}

/** Re-read each picked contact from the CRM so the import records what the CRM holds, not what a form posted. */
export async function getCrmContact(env: CrmEnv, id: string): Promise<CrmContact | null> {
  try {
    return await crmFetch<CrmContact>(env, `/api/contacts/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

/** Best-effort note on the CRM contact's timeline. Never blocks the caller. */
export async function logCrmActivity(env: CrmEnv, contactId: string, body: string): Promise<void> {
  if (!crmConfigured(env)) return;
  try {
    await crmFetch(env, "/api/activities", {
      method: "POST",
      body: JSON.stringify({ entity_type: "contact", entity_id: contactId, type: "note", body }),
    });
  } catch {
    /* the CRM note is a courtesy; local state is already correct */
  }
}
