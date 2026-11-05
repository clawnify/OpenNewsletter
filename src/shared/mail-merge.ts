/**
 * Merge two writers' changes to one issue: the editor's unsaved edits and a
 * newer copy someone else saved (the Clawnify chat, through the edit route).
 *
 * Three-way, against `base`, the copy the editor's edits started from:
 * whatever the editor changed since base wins on that field or that block;
 * everything else comes from `remote`. Blocks merge by id, so the chat
 * rewriting one block while the user types in another keeps both. Status and
 * schedule fields always come from remote: only the send routes write them.
 */
import { deriveTitle } from "./blocks";
import type { Block, Mail } from "./types";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Content fields the editor writes besides the blocks. The subject is derived from the blocks. */
const FIELDS = ["eyebrow", "preheader", "subtitle", "byline_name", "byline_date", "feature_image", "design", "design_mobile", "template_slug", "audience_id"] as const;

export function mergeBlocks(base: Block[], local: Block[], remote: Block[]): Block[] {
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  const baseById = new Map(base.map((b) => [b.id, b]));
  const localById = new Map(local.map((b) => [b.id, b]));
  const edited = (b: Block) => !baseById.has(b.id) || !same(b, baseById.get(b.id));
  const out = remote.flatMap((r): Block[] => {
    const l = localById.get(r.id);
    if (!l) return baseById.has(r.id) ? [] : [r]; // removed in the editor; or new from remote
    return [edited(l) ? l : r];
  });
  // Blocks the editor added, or edited where remote removed them: keep them,
  // after the block that precedes them in the editor.
  local.forEach((b, i) => {
    if (out.some((x) => x.id === b.id) || !edited(b)) return;
    const prev = local.slice(0, i).reverse().find((p) => out.some((x) => x.id === p.id));
    out.splice(prev ? out.findIndex((x) => x.id === prev.id) + 1 : 0, 0, b);
  });
  return out;
}

export function mergeMail(base: Mail, local: Mail, remote: Mail): Mail {
  const out: Mail = { ...remote };
  for (const f of FIELDS) if (!same(local[f], base[f])) (out as unknown as Record<string, unknown>)[f] = local[f];
  out.blocks = mergeBlocks(base.blocks || [], local.blocks || [], remote.blocks || []);
  if (!same(out.blocks, remote.blocks)) out.title = deriveTitle(out.blocks);
  return out;
}

/** Content the editor would have to save to turn `remote` into `merged`. Empty when they match. */
export function contentPatch(remote: Mail, merged: Mail): Partial<Mail> {
  const patch: Partial<Mail> = {};
  for (const f of FIELDS) if (!same(merged[f], remote[f])) (patch as Record<string, unknown>)[f] = merged[f];
  if (!same(merged.blocks, remote.blocks)) patch.blocks = merged.blocks;
  return patch;
}
