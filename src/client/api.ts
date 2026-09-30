export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const text = await r.text();
  // Tolerate non-JSON error bodies (e.g. a bare "Internal Server Error" on a
  // 500) so we surface the real message, not "Unexpected token 'I'".
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!r.ok) {
    const msg = (data as { error?: string }).error || text || `Request failed (${r.status})`;
    // The parsed body rides along for callers that act on more than the message.
    throw Object.assign(new Error(`${msg} (${r.status})`), { status: r.status, data });
  }
  return data as T;
}
