import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Monitor, Smartphone, ArrowLeft, Send, Save, RotateCcw, MousePointer2, Undo2, Redo2, Eye, SquarePen } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import { baseDesign, effectiveDesign } from "../lib/design";
import { diffTokens, withDefaults, type DesignTokens } from "../../shared/design";
import { newBlock } from "../../shared/blocks";
import { applyMailOp, designSummary, mailOutline } from "../../shared/mail-ops";
import { contentPatch, mergeMail } from "../../shared/mail-merge";
import type { Block, BlockType, Mail } from "../../shared/types";
import { SAMPLE_VALUES, fillBlocksText } from "../../shared/merge";
import { Preview, type EditHandlers } from "./preview";
import { DesignPanel } from "./design-panel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SendDialog } from "./send-dialog";
import { TestSendDialog } from "./test-send-dialog";
import { AppChat, embedded, useChatCommands, useChatContext, useHostChanges } from "@clawnify/app/client";
import { Chat, type ChatContext, type ApplyTool } from "./chat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isLate, statusTone, whenLabel } from "../lib/status";
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

  // The last copy the server confirmed: the base this editor's unsaved edits
  // are measured against, and the rev every save names.
  const savedRef = useRef<Mail | null>(mail);
  useEffect(() => {
    if (!mail) api<Mail>("GET", `/api/mails/${mailId}`).then((m) => { savedRef.current = m; setMail(m); }).catch((e) => store.setError((e as Error).message));
  }, [mailId]);

  const base = useMemo(() => (mail ? baseDesign(mail, store.templates) : withDefaults(null)), [mail, store.templates]);
  const design = useMemo<DesignTokens>(() => (mail ? effectiveDesign(mail, store.templates, device) : withDefaults(null)), [mail, store.templates, device]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Edits inside one debounce window are merged: saving only the last patch
  // dropped an earlier edit to another field (preview text, then a block).
  const pending = useRef<Partial<Mail>>({});
  const inFlight = useRef<Promise<void> | null>(null);
  const queueSave = (_next: Mail, patch: Partial<Mail>) => {
    setSaved(false);
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };
  // Every save names the rev it started from. If someone else (the Clawnify
  // chat) saved in between, the server refuses it (409) with its copy, and the
  // edits merge into that copy and save again, instead of erasing its change.
  const flush = () => {
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    const run: Promise<void> = (async () => {
      try {
        savedRef.current = await store.saveMail(mailId, { ...patch, rev: savedRef.current?.rev });
        if (!timer.current) setSaved(true);
      } catch (e) {
        const err = e as Error & { status?: number; data?: { mail?: Mail } };
        if (err.status === 409 && err.data?.mail) reconcile(err.data.mail);
        else store.setError(err.message);
      }
    })();
    inFlight.current = run;
    void run.finally(() => { if (inFlight.current === run) inFlight.current = null; });
  };
  /**
   * Take in a newer copy from the server, keeping this editor's unsaved edits
   * (src/shared/mail-merge.ts): its edits win on what they touched, the rest
   * and the send state come from the server. A visible change from the other
   * writer goes on the undo stack, so Undo takes it back.
   */
  const reconcile = (remote: Mail) => {
    const cur = live.current.mail;
    const base = savedRef.current;
    savedRef.current = remote;
    if (!cur || !base) { live.current.mail = remote; setMail(remote); return; }
    const merged = mergeMail(base, cur, remote);
    const shown = (m: Mail) => JSON.stringify([m.blocks, m.preheader, m.eyebrow, m.subtitle, m.design, m.design_mobile]);
    if (shown(merged) !== shown(cur)) record(cur);
    live.current.mail = merged;
    setMail(merged);
    const left = contentPatch(remote, merged);
    pending.current = left; // what this editor still has to save, measured against the new copy
    if (Object.keys(left).length) queueSave(merged, {});
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

  // Undo and redo move content only. Whether the issue is scheduled, sending
  // or sent, and who it goes to (picked in the send dialog), is what happened
  // since, and an older copy must not put it back.
  const restore = (snap: Mail) => {
    const cur = live.current.mail;
    const next = cur
      ? { ...snap, status: cur.status, scheduled_at: cur.scheduled_at, sent_at: cur.sent_at, send_error: cur.send_error, audience_id: cur.audience_id }
      : snap;
    setMail(next);
    queueSave(next, next);
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

  // ── The Clawnify sidebar chat ───────────────────────────────────────
  // Inside Clawnify the dashboard's chat is the assistant. It edits through
  // POST /api/mails/:id/edit; when it writes, refetch and put its edit on the
  // undo stack, so the user's Undo takes back what the chat did. Edits typed
  // in the last moment and not yet saved stay on top of the fresh copy.
  const fetchSeq = useRef(0);
  useHostChanges(async (paths) => {
    // Only writes to this issue (the edit route, a send, a schedule) matter here.
    const mine = new RegExp(`^/api/mails/${mailId}(/|\\?|$)`);
    if (paths.length && !paths.some((p) => mine.test(p))) return;
    const seq = ++fetchSeq.current;
    await inFlight.current?.catch(() => {}); // a save in flight settles first (it may 409 and merge)
    try {
      const fresh = await api<Mail>("GET", `/api/mails/${mailId}`);
      if (seq === fetchSeq.current) reconcile(fresh); // a later change's fetch wins over this one
    } catch { /* the next change, or the next save's 409, catches up */ }
  });
  // What the chat is told is on screen. Ids only, never content: it reads the
  // issue itself through GET /api/mails/:id/context.
  // shortcut: focused block ids ride the 60-character context label, so about
  // four fit; past that the chat hears only how many. A record per block if
  // people focus more.
  const focusIds = [...aiSelected];
  const focusLabel = `Issue editor, focus ${focusIds.join(",")}`;
  useChatContext(
    mail
      ? {
          label: !focusIds.length ? "Issue editor" : focusLabel.length <= 60 ? focusLabel : `Issue editor, ${focusIds.length} blocks in focus`,
          record: { type: mail.flow ? "automation email" : "newsletter issue", id: String(mail.id), label: mail.title || "Untitled" },
        }
      : null,
  );
  const which = mail?.flow ? `the automation email #${mailId}` : `newsletter issue #${mailId}`;
  const scope = focusIds.length ? ` (only the blocks in focus: ${focusIds.join(", ")})` : "";
  useChatCommands([
    { id: "draft-from-sources", label: "Draft from my sources", description: "Recent activity in the sources set in Settings", prompt: `Write ${which} from my sources' recent activity. Keep its layout and rewrite each block in place.` },
    { id: "tighten", label: "Tighten the copy", prompt: `Tighten the copy of ${which}${scope}: shorter sentences, same facts, same layout.` },
    { id: "subject", label: "Subject and preview text", prompt: `Write a subject line and preview text for ${which} that make people want to open it.` },
    { id: "brand", label: "Match my brand", prompt: `Restyle ${which} to match my brand: colours, fonts and roundness. Change the design tokens, not the copy.` },
  ]);

  // ── In-app assistant bridge (outside Clawnify) ──────────────────────
  // A compact snapshot of the mail the assistant sees each turn.
  const getContext = (): ChatContext => {
    const cur = live.current.mail;
    if (!cur) return {};
    const outline = mailOutline(cur.blocks || []);
    const focus = [...aiSelected];
    const focusNote = focus.length ? `\n\nThe user has these block ids in focus — scope edits to them: ${focus.join(", ")}` : "";
    return { title: cur.title || undefined, outline: outline + focusNote, design: designSummary(design) };
  };

  // Applies a streamed tool-call to the live mail; returns a short result line.
  // The op itself is shared with the API the Clawnify sidebar chat uses.
  const applyTool: ApplyTool = (name, input) => {
    const cur = live.current.mail;
    if (!cur) return "No newsletter is open.";
    const r = applyMailOp(cur, name, input, { base, device });
    if (!r.ok) return r.message;
    record(cur);
    const next = { ...cur, ...r.patch };
    live.current.mail = next; // sync so chained tool-calls in one turn compose
    setMail(next);
    queueSave(next, r.patch);
    return r.message;
  };

  // Naming happens in a dialog with the input first and focused, never window.prompt.
  const [templateName, setTemplateName] = useState<string | null>(null);
  const unschedule = async () => {
    try {
      const res = await api<{ mail: Mail }>("POST", `/api/mails/${mailId}/unschedule`);
      setMail((m) => (m ? { ...m, status: res.mail.status, scheduled_at: res.mail.scheduled_at } : m));
      store.refreshMails();
    } catch (e) {
      store.setError((e as Error).message);
      // Most likely the job already ran: show the mail as it is now.
      api<Mail>("GET", `/api/mails/${mailId}`).then(setMail).catch(() => {});
    }
  };
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
          {mail.segment === "inactive" ? (
            <Badge
              className="bg-info-tint text-info"
              title={`Goes only to subscribers with no open or click in ${mail.segment_days || 90} days. The email always ends with a “Yes, keep me subscribed” button; whoever doesn't answer stops getting your newsletter.`}
            >
              To inactive subscribers
            </Badge>
          ) : null}
          <span className="max-w-[260px] truncate font-medium">{mail.title || "Untitled"}</span>
          <span className="text-xs text-muted-foreground">{saved ? "Saved" : "Saving…"}</span>
          {mail.status === "scheduled" ? (
            <>
              {isLate(mail) ? (
                <Badge className="bg-warning-tint text-warning" title="Its time has passed and it hasn't gone out. Send it now, or cancel and schedule again.">
                  Late: was due {whenLabel(mail.scheduled_at!)}
                </Badge>
              ) : (
                <Badge className={statusTone(mail.status)}>Scheduled{mail.scheduled_at ? ` · ${whenLabel(mail.scheduled_at)}` : ""}</Badge>
              )}
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={unschedule}>Cancel schedule</Button>
            </>
          ) : sent ? <DeliveryStats mail={mail} /> : mail.send_error ? (
            <Badge className="max-w-[320px] truncate bg-warning-tint text-warning" title={mail.send_error}>{mail.send_error}</Badge>
          ) : null}
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
        {/* The app's own assistant, drawn only outside Clawnify: inside the
            dashboard the sidebar chat is the assistant and this renders nothing. */}
        <AppChat
          standalone={(chat) => (
            <aside className="hidden w-96 shrink-0 flex-col border-r md:flex" onClick={(e) => e.stopPropagation()}>
              <Chat
                key={mailId}
                mailId={mailId}
                getContext={getContext}
                applyTool={applyTool}
                available={!!store.status?.ai_available}
                selectedCount={aiSelected.size}
                onClearSelection={() => setAiSelected(new Set())}
                sources={store.settings?.sources ?? []}
                draft={chat.draft}
              />
            </aside>
          )}
        />

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
              <MousePointer2 size={13} /> Click blocks to focus them, then ask {embedded ? "the chat" : "the assistant"} to rewrite them. <strong>{aiSelected.size} in focus</strong>.
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
