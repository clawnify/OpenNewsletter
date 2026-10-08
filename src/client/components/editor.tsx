import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Smartphone, ArrowLeft, Send, Save, RotateCcw, MousePointer2, Undo2, Redo2, Eye, SquarePen } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { baseDesign, effectiveDesign } from "../lib/design";
import { diffTokens, withDefaults, type DesignTokens } from "../../shared/design";
import { newBlock, markdownToBlocks, deriveTitle, blockId } from "../../shared/blocks";
import type { Block, BlockType, Mail } from "../../shared/types";
import { SAMPLE_VALUES, fillBlocksText } from "../../shared/merge";
import { Preview, type EditHandlers } from "./preview";
import { DesignPanel } from "./design-panel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SendDialog } from "./send-dialog";
import { TestSendDialog } from "./test-send-dialog";
import { Chat, type ChatContext, type ApplyTool } from "./chat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { statusTone } from "../lib/status";
import { DeliveryStats } from "./delivery-stats";

export function Editor({ mailId, onBack }: { mailId: number; onBack: () => void }) {
  const store = useStore();
  const [mail, setMail] = useState<Mail | null>(store.mails.find((i) => i.id === mailId) || null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [selectedId, setSelected] = useState<string | null>(null);
  const [aiSelected, setAiSelected] = useState<Set<string>>(new Set());
  const [showSend, setShowSend] = useState(false);
  const [showTest, setShowTest] = useState(false);
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
  // Edits inside one debounce window are merged: saving only the last patch
  // dropped an earlier edit to another field (preview text, then a block).
  const pending = useRef<Partial<Mail>>({});
  const queueSave = (next: Mail, patch: Partial<Mail>) => {
    setSaved(false);
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const merged = pending.current;
      pending.current = {};
      try {
        await store.saveMail(next.id, merged);
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
  // How far this mail's own design has moved from its template's, if it has both.
  const template = mail ? store.templates.find((t) => t.slug === mail.template_slug) : undefined;
  const designChanges = mail?.design && template
    ? Object.values(diffTokens(withDefaults(template.design), withDefaults(mail.design))).reduce((n, g) => n + Object.keys(g || {}).length, 0)
    : 0;

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
      (cur.blocks || []).map((b) => `[${b.id}] ${b.type}${b.box?.background ? ` (section ${b.box.background})` : ""}: ${blockPreview(b)}`).join("\n") || "(empty)";
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
            case "html": return { ...b, html: text };
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
      case "style_block": {
        let found = false;
        const blocks = (cur.blocks || []).map((b): Block => {
          if (b.id !== input.block_id) return b;
          found = true;
          const next = { ...b } as Block & Record<string, unknown>;
          if (input.background !== undefined || input.padding !== undefined) {
            const bg = input.background === "none" ? undefined : input.background !== undefined ? String(input.background) : b.box?.background;
            const pad = input.padding !== undefined ? Number(input.padding) : b.box?.padding;
            next.box = bg || pad ? { ...(bg ? { background: bg } : {}), ...(pad !== undefined ? { padding: pad } : {}) } : undefined;
          }
          if (b.type === "image") {
            if (input.image_width !== undefined) next.width = Number(input.image_width);
            if (input.image_align !== undefined) next.align = input.image_align;
          }
          if (b.type === "button") {
            if (input.button_variant !== undefined) next.variant = input.button_variant === "outline" ? "outline" : undefined;
            if (input.button_full_width !== undefined) next.fullWidth = input.button_full_width ? true : undefined;
          }
          return next;
        });
        if (!found) return `No block ${input.block_id}.`;
        commit({ blocks });
        return "Styled the block.";
      }
      case "add_html_block": {
        const block: Block = { id: blockId(), type: "html", html: String(input.html || "") };
        const curBlocks = cur.blocks || [];
        commit({ blocks: input.position === "start" ? [block, ...curBlocks] : [...curBlocks, block] });
        return "Added the HTML block.";
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
          <Badge variant="secondary">{mail.flow ? "Automation email" : "Mail"}</Badge>
          <span className="max-w-[260px] truncate font-medium">{mail.title || "Untitled"}</span>
          <span className="text-xs text-muted-foreground">{saved ? "Saved" : "Saving…"}</span>
          {mail.status === "scheduled" ? <Badge className={`capitalize ${statusTone(mail.status)}`}>{mail.status}</Badge> : sent ? <DeliveryStats mail={mail} /> : null}
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
          {mail.flow ? (
            <Button size="sm" variant="outline" onClick={() => setShowTest(true)} title={`Sent by "${mail.flow.name}" to each new subscriber`}><Send size={15} /> Send test</Button>
          ) : (
            <Button size="sm" onClick={() => setShowSend(true)}><Send size={15} /> Send</Button>
          )}
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
              {mode === "edit" ? (
                <InboxLine mail={mail} onPreheader={(preheader) => patch({ preheader })} />
              ) : null}
              <Preview
                mail={mode === "edit" ? mail : { ...mail, blocks: fillBlocksText(mail.blocks, SAMPLE_VALUES) }}
                design={design}
                settings={store.settings!}
                edit={mode === "edit" ? edit : undefined}
              />
            </div>
          </div>
        </div>

        <aside className="hidden w-80 shrink-0 border-l bg-background lg:flex lg:flex-col">
          {device === "desktop" && designChanges > 0 && mail.status !== "sent" && mail.status !== "sending" ? (
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
              <span>
                {designChanges} {designChanges === 1 ? "change" : "changes"} from {template!.name}
              </span>
              <button className="inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 shadow-edge hover:bg-card" onClick={() => patch({ design: null })}>
                <RotateCcw size={11} /> Reset
              </button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <DesignPanel design={design} onChange={patchDesign} />
          </div>
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
      {showTest ? <TestSendDialog mail={mail} onClose={() => setShowTest(false)} /> : null}
      {showSend ? <SendDialog mail={mail} onClose={() => setShowSend(false)} onSent={(i) => { setMail(i); setShowSend(false); store.refreshMails(); }} /> : null}
    </div>
  );
}

/**
 * What the inbox shows before the mail is opened: the subject (the title
 * block) and the preview text. Saved on blur, so one edit is one undo step.
 */
function InboxLine({ mail, onPreheader }: { mail: Mail; onPreheader: (v: string) => void }) {
  return (
    <div className="mb-4 rounded-md bg-card p-3 text-sm shadow-edge">
      <div className="flex items-baseline gap-3">
        <span className="w-24 shrink-0 text-muted-foreground">Subject</span>
        <span className="truncate font-medium">{mail.title || "Untitled"}</span>
      </div>
      <label className="mt-2 flex items-center gap-3">
        <span className="w-24 shrink-0 text-muted-foreground">Preview text</span>
        <Input
          key={`${mail.id}:${mail.preheader}`}
          defaultValue={mail.preheader}
          placeholder="Shown after the subject in the inbox"
          maxLength={150}
          onBlur={(e) => { if (e.target.value !== mail.preheader) onPreheader(e.target.value); }}
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        Personalize any text with <code>{"{{first_name|there}}"}</code>, <code>{"{{last_name}}"}</code> or <code>{"{{email}}"}</code>. The word after the bar shows when the value is empty. Preview fills in a sample reader.
      </p>
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
    // In full (to a cap), so the assistant can rewrite it with edit_block.
    case "html": return b.html.length > 4000 ? b.html.slice(0, 4000) + "\n…(truncated)" : b.html;
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
