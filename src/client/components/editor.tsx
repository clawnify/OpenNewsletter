import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Smartphone, ArrowLeft, Send, Save, RotateCcw, MousePointer2, Undo2, Redo2, Eye, SquarePen } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { baseDesign, effectiveDesign } from "../lib/design";
import { diffTokens, withDefaults, type DesignTokens } from "../../shared/design";
import { newBlock, markdownToBlocks, deriveTitle, blockId } from "../../shared/blocks";
import type { Block, BlockType, Mail } from "../../shared/types";
import { Preview, type EditHandlers } from "./preview";
import { DesignPanel } from "./design-panel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SendDialog } from "./send-dialog";
import { Chat, type ChatContext, type ApplyTool } from "./chat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function Editor({ mailId, onBack }: { mailId: number; onBack: () => void }) {
  const store = useStore();
  const [mail, setMail] = useState<Mail | null>(store.mails.find((i) => i.id === mailId) || null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [selectedId, setSelected] = useState<string | null>(null);
  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  const [showSend, setShowSend] = useState(false);
  const [saved, setSaved] = useState(true);

  // The assistant (and click-to-focus) target these blocks when set.
  const selectMode = aiSelected.size > 0;

  // Undo/redo: snapshots of the whole mail. `record` is called before any
  // meaningful change (edits, block ops, design, assistant). Capped at 50 steps.
  const [history, setHistory] = useState<Mail[]>([]);
  const [future, setFuture] = useState<Mail[]>([]);
  const live = useRef({ mail, history, future });
  live.current = { mail, history, future };

  useEffect(() => {
    if (!mail) api<Mail>("GET", `/api/mails/${mailId}`).then(setMail).catch((e) => store.setError((e as Error).message));
  }, [mailId]);

  const base = useMemo(() => (mail ? baseDesign(mail, store.templates) : withDefaults(null)), [mail, store.templates]);
  const design = useMemo<DesignTokens>(() => (mail ? effectiveDesign(mail, store.templates, device) : withDefaults(null)), [mail, store.templates, device]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSave = (next: Mail, patch: Partial<Mail>) => {
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await store.saveMail(next.id, patch);
        setSaved(true);
      } catch (e) {
        store.setError((e as Error).message);
      }
    }, 500);
  };
  /** Snapshot the current mail onto the undo stack and clear redo. */
  const record = (cur: Mail) => {
    setHistory((h) => [...h.slice(-49), cur]);
    setFuture([]);
  };

  const patch = (p: Partial<Mail>) => {
    if (!mail) return;
    record(mail);
    const next = { ...mail, ...p };
    setMail(next);
    queueSave(next, p);
  };

  const restore = (snap: Mail) => {
    setMail(snap);
    queueSave(snap, snap);
  };
  const undo = useCallback(() => {
    const { mail, history } = live.current;
    if (!mail || !history.length) return;
    setHistory((h) => h.slice(0, -1));
    setFuture((f) => [mail, ...f].slice(0, 50));
    restore(history[history.length - 1]);
  }, []);
  const redo = useCallback(() => {
    const { mail, future } = live.current;
    if (!mail || !future.length) return;
    setFuture((f) => f.slice(1));
    setHistory((h) => [...h.slice(-49), mail]);
    restore(future[0]);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((!e.metaKey && !e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = document.activeElement as HTMLElement | null;
      // While typing in a field, let the browser's native undo handle it.
      if (el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const setBlocks = (blocks: Block[]) => patch({ blocks });
  const onBlock = (id: string, p: Record<string, unknown>) => setBlocks((mail!.blocks || []).map((b) => (b.id === id ? ({ ...b, ...p } as Block) : b)));
  const onReplace = (id: string, block: Block) => setBlocks((mail!.blocks || []).map((b) => (b.id === id ? block : b)));
  const onAdd = (index: number, type: BlockType) => {
    const blocks = (mail!.blocks || []).slice();
    const b = newBlock(type);
    blocks.splice(index, 0, b);
    setBlocks(blocks);
    setSelected(b.id);
  };
  const onMove = (index: number, dir: -1 | 1) => {
    const blocks = (mail!.blocks || []).slice();
    const j = index + dir;
    if (j < 0 || j >= blocks.length) return;
    [blocks[index], blocks[j]] = [blocks[j], blocks[index]];
    setBlocks(blocks);
  };
  const onDelete = (index: number) => setBlocks((mail!.blocks || []).filter((_, i) => i !== index));

  const patchDesign = (edited: DesignTokens) => {
    if (device === "mobile") patch({ design_mobile: diffTokens(base, edited) });
    else patch({ design: edited });
  };
  const resetMobile = () => patch({ design_mobile: null });

  const toggleAI = (id: string) =>
    setAiSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Assistant bridge ────────────────────────────────────────────────
  // A compact snapshot of the mail the assistant sees each turn.
  const getContext = (): ChatContext => {
    const cur = live.current.mail;
    if (!cur) return {};
    const outline =
      (cur.blocks || []).map((b) => `[${b.id}] ${b.type}: ${blockPreview(b)}`).join("\n") || "(empty)";
    const focus = [...aiSelected];
    const focusNote = focus.length ? `\n\nThe user has these block ids in focus — scope edits to them: ${focus.join(", ")}` : "";
    const d = `primary ${design.colors.primary}, background ${design.colors.background}, heading font ${design.typography.headingFont}, button radius ${design.layout.buttonRadius}px`;
    return { title: cur.title || undefined, outline: outline + focusNote, design: d };
  };

  // Applies a streamed tool-call to the live mail; returns a short result line.
  const applyTool: ApplyTool = (name, input) => {
    const cur = live.current.mail;
    if (!cur) return "No newsletter is open.";
    const commit = (p: Partial<Mail>) => {
      record(cur);
      const next = { ...cur, ...p };
      live.current.mail = next; // sync so chained tool-calls in one turn compose
      setMail(next);
      queueSave(next, p);
    };
    switch (name) {
      case "set_content": {
        const blocks = markdownToBlocks(String(input.markdown || ""));
        commit({ blocks, title: deriveTitle(blocks) });
        return `Replaced the body with ${blocks.length} block(s).`;
      }
      case "add_block": {
        const add = markdownToBlocks(String(input.markdown || ""));
        const curBlocks = cur.blocks || [];
        const blocks = input.position === "start" ? [...add, ...curBlocks] : [...curBlocks, ...add];
        commit({ blocks });
        return `Added ${add.length} block(s).`;
      }
      case "edit_block": {
        const text = String(input.text ?? input.markdown ?? "");
        let touched = false;
        const blocks = (cur.blocks || []).map((b): Block => {
          if (b.id !== input.block_id) return b;
          touched = true;
          switch (b.type) {
            case "heading": return { ...b, text };
            case "text": return { ...b, md: text };
            case "button": return { ...b, text, ...(input.href ? { href: String(input.href) } : {}) };
            case "quote": return { ...b, text };
            case "list": return { ...b, items: text.split("\n").map((s) => s.replace(/^\s*[-*+]\s+|^\s*\d+\.\s+/, "").trim()).filter(Boolean) };
            case "image": return { ...b, alt: text };
            default: return b; // divider / spacer / columns — nothing textual to set
          }
        });
        if (!touched) return `No block with id ${input.block_id}.`;
        commit({ blocks });
        return "Rewrote the block in place.";
      }
      case "remove_block": {
        commit({ blocks: (cur.blocks || []).filter((b) => b.id !== input.block_id) });
        return "Removed the block.";
      }
      case "set_title": {
        commit({ title: String(input.title || "") });
        return "Set the title.";
      }
      case "set_design": {
        const next = setDesignKey(base, String(input.key), input.value);
        if (!next) return `I can't set "${input.key}".`;
        commit(device === "mobile" ? { design_mobile: diffTokens(base, next) } : { design: next });
        return `Set ${input.key}.`;
      }
      case "add_image": {
        // src is resolved by the chat (it uploads the attachment before calling).
        const src = String(input.src || "");
        if (!src) return "No image to add.";
        const block: Block = { id: blockId(), type: "image", src, alt: String(input.alt || ""), caption: "", href: "" };
        commit({ blocks: [...(cur.blocks || []), block] });
        return "Added the image.";
      }
      default:
        return `Unknown tool: ${name}`;
    }
  };

  // Naming happens in a dialog with the input first and focused, never window.prompt.
  const [templateName, setTemplateName] = useState<string | null>(null);
  const saveAsTemplate = () => { if (mail) setTemplateName(mail.title?.slice(0, 40) || "My template"); };
  const confirmSaveAsTemplate = async () => {
    const name = templateName?.trim();
    setTemplateName(null);
    if (!mail || !name) return;
    try {
      await api("POST", "/api/templates", { name, from_mail_id: mail.id });
      await store.refreshTemplates();
    } catch (e) {
      store.setError((e as Error).message);
    }
  };

  if (!mail) return <div className="flex h-full items-center justify-center text-muted-foreground">Loading…</div>;

  const edit: EditHandlers = {
    onMail: patch, onBlock, onReplace, onAdd, onMove, onDelete,
    onBlockAI: (b) => toggleAI(b.id),
    selectedId, setSelected, selectMode, aiSelected, toggleAI,
  };
  const sent = mail.status !== "draft";

  return (
    <div className="flex h-full min-w-0 flex-col" onClick={() => !selectMode && setSelected(null)}>
      <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back"><ArrowLeft size={18} /></Button>
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary">Mail</Badge>
          <span className="max-w-[260px] truncate font-medium">{mail.title || "Untitled"}</span>
          <span className="text-xs text-muted-foreground">{saved ? "Saved" : "Saving…"}</span>
          {sent ? <Badge className="bg-success-tint capitalize text-success">{mail.status}</Badge> : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center">
            <Button variant="ghost" size="icon" onClick={undo} disabled={!history.length} title="Undo (⌘Z)" aria-label="Undo"><Undo2 size={16} /></Button>
            <Button variant="ghost" size="icon" onClick={redo} disabled={!future.length} title="Redo (⌘⇧Z)" aria-label="Redo"><Redo2 size={16} /></Button>
          </div>
          <Segmented
            options={[{ v: "desktop", label: "Desktop", icon: <Monitor size={15} /> }, { v: "mobile", label: "Mobile", icon: <Smartphone size={15} /> }]}
            value={device}
            onChange={(v) => setDevice(v as "desktop" | "mobile")}
          />
          <Button variant="outline" size="sm" onClick={saveAsTemplate}><Save size={15} /> Save as…</Button>
          <Button size="sm" onClick={() => setShowSend(true)}><Send size={15} /> Send</Button>
        </div>

        {/* Edit / Preview — centered in the nav, independent of the side groups */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto">
            <Segmented
              options={[{ v: "edit", label: "Edit", icon: <SquarePen size={15} /> }, { v: "preview", label: "Preview", icon: <Eye size={15} /> }]}
              value={mode}
              onChange={(v) => setMode(v as "edit" | "preview")}
            />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-96 shrink-0 flex-col border-r md:flex" onClick={(e) => e.stopPropagation()}>
          <Chat
            key={mailId}
            mailId={mailId}
            getContext={getContext}
            applyTool={applyTool}
            available={!!store.status?.ai_available}
            selectedCount={aiSelected.size}
            onClearSelection={() => setAiSelected(new Set())}
          />
        </aside>

        {/* design-lint: allow — a document canvas: the email preview sits on a desk */}
        <div className="flex min-w-0 flex-1 flex-col bg-muted">
          {device === "mobile" ? (
            <div className="flex items-center justify-center gap-2 border-b border-border bg-warning-tint py-1.5 text-xs text-warning">
              <Smartphone size={13} /> Editing <strong>mobile overrides</strong> — changes here only affect phones.
              {mail.design_mobile && Object.keys(mail.design_mobile).length ? (
                <button className="ml-1 inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 shadow-edge hover:bg-card" onClick={resetMobile}><RotateCcw size={11} /> reset</button>
              ) : null}
            </div>
          ) : null}
          {mode === "edit" && selectMode ? (
            <div className="flex items-center justify-center gap-2 border-b border-primary/30 bg-accent py-1.5 text-xs text-foreground">
              <MousePointer2 size={13} /> Click blocks to focus them, then ask the assistant to rewrite them. <strong>{aiSelected.size} in focus</strong>.
            </div>
          ) : null}

          <div className="flex-1 overflow-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto transition-all" style={{ maxWidth: device === "mobile" ? 390 : design.layout.contentWidth + 80 }}>
              <Preview mail={mail} design={design} settings={store.settings!} edit={mode === "edit" ? edit : undefined} />
            </div>
          </div>
        </div>

        <aside className="hidden w-80 shrink-0 border-l bg-background lg:block">
          <DesignPanel design={design} onChange={patchDesign} />
        </aside>
      </div>

      {templateName !== null && (
        <Dialog open onOpenChange={(o) => { if (!o) setTemplateName(null); }}>
          <DialogContent className="max-w-sm">
            <form onSubmit={(e) => { e.preventDefault(); void confirmSaveAsTemplate(); }} className="flex flex-col gap-4">
              <DialogHeader><DialogTitle>Save as template</DialogTitle></DialogHeader>
              <Input autoFocus value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="Template name" aria-label="Template name" />
              <DialogFooter>
                <DialogClose asChild><Button type="button" variant="ghost">Cancel <kbd className="ml-1 rounded-xs bg-muted px-1 text-[10px] text-muted-foreground">Esc</kbd></Button></DialogClose>
                <Button type="submit" disabled={!templateName?.trim()}>Save <kbd className="ml-1 rounded-xs bg-white/15 px-1 text-[10px]">⏎</kbd></Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {showSend ? <SendDialog mail={mail} onClose={() => setShowSend(false)} onSent={(i) => { setMail(i); setShowSend(false); store.refreshMails(); }} /> : null}
    </div>
  );
}

/** One-line preview of a block, for the assistant's outline. */
function blockPreview(b: Block): string {
  const clip = (s: string) => (s.length > 60 ? s.slice(0, 57) + "…" : s);
  switch (b.type) {
    case "heading": return clip(b.text) + ` (h${b.level})`;
    case "text": return clip(b.md);
    case "image": return `image ${b.alt || b.src}`;
    case "button": return `button "${b.text}"`;
    case "list": return clip(b.items.join(", "));
    case "quote": return clip(b.text);
    case "divider": return "divider";
    case "spacer": return "spacer";
    case "columns": return `${b.items.length} columns`;
  }
}

const DESIGN_KEYS = new Set([
  "colors.primary", "colors.background", "colors.text", "colors.secondary", "colors.onPrimary",
  "typography.headingFont", "typography.bodyFont",
  "layout.buttonRadius", "layout.imageRadius", "layout.cardRadius", "layout.contentWidth", "layout.outerPadding",
]);

/** Set one allow-listed dot-path token on a clone of the base design. */
function setDesignKey(base: DesignTokens, key: string, value: unknown): DesignTokens | null {
  if (!DESIGN_KEYS.has(key)) return null;
  const next = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  const [group, field] = key.split(".");
  next[group][field] = value;
  return next as unknown as DesignTokens;
}

function Segmented<T extends string>({ options, value, onChange }: { options: { v: T; label: string; icon?: React.ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {options.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition ${value === o.v ? "bg-card text-foreground shadow-raised" : "text-muted-foreground"}`}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}
