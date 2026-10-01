import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ChevronUp, ChevronDown, ChevronsUpDown, Trash2, Sparkles, Plus, Check,
  Image as ImageIcon, Type, Heading, List as ListIcon, Quote, Minus, MousePointerClick, Columns as ColumnsIcon, Upload, Code, Paintbrush,
} from "lucide-react";
import { BOX_COLORS, blockBox, renderBlock, renderHtmlBlock } from "../../shared/email-blocks";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { markdownToHtml } from "../../shared/markdown";
import { designVars, fontStack, type DesignTokens } from "../../shared/design";
import { TEXT_PRESETS, currentPreset, applyPreset, type TextPreset } from "../../shared/blocks";
import { readableTextOn } from "../../shared/contrast";
import type { Block, BlockType, Mail, Settings, TextColor } from "../../shared/types";
import { Editable } from "./editable";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface EditHandlers {
  onMail: (patch: Partial<Mail>) => void;
  onBlock: (id: string, patch: Record<string, unknown>) => void;
  onReplace: (id: string, block: Block) => void;
  onAdd: (index: number, type: BlockType) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onDelete: (index: number) => void;
  onBlockAI: (block: Block) => void;
  selectedId: string | null;
  setSelected: (id: string | null) => void;
  selectMode: boolean;
  aiSelected: Set<string>;
  toggleAI: (id: string) => void;
}

function colorOf(c: TextColor | undefined, d: DesignTokens): string {
  if (c === "primary") return d.colors.primary;
  if (c === "secondary") return d.colors.secondary;
  return d.colors.foreground;
}

function headingStyle(level: 1 | 2 | 3, d: DesignTokens): CSSProperties {
  const size = level === 1 ? d.typography.titleSize : level === 2 ? d.typography.baseSize + 8 : d.typography.baseSize + 3;
  return {
    margin: 0,
    fontFamily: fontStack(d.typography.headingFont),
    fontWeight: d.typography.headingWeight,
    fontSize: size,
    lineHeight: level === 1 ? 1.12 : 1.25,
    letterSpacing: level === 1 ? "-0.01em" : "0",
    color: d.colors.foreground,
  };
}

function textStyle(b: Extract<Block, { type: "text" }>, d: DesignTokens): CSSProperties {
  return {
    margin: 0,
    fontFamily: fontStack(d.typography.bodyFont),
    fontSize: Math.round(d.typography.baseSize * (b.scale || 1)),
    lineHeight: d.typography.lineHeight,
    color: colorOf(b.color, d),
    textAlign: b.align || "left",
    fontStyle: b.italic ? "italic" : "normal",
    textTransform: b.uppercase ? "uppercase" : "none",
    letterSpacing: b.uppercase ? "0.06em" : "normal",
    fontWeight: b.uppercase ? 600 : 400,
  };
}

export function Preview({ mail, design, settings, edit }: { mail: Mail; design: DesignTokens; settings: Settings; edit?: EditHandlers }) {
  const vars = designVars(design) as CSSProperties;
  const cardPad = design.layout.cardRadius > 0 ? 32 : 28;

  return (
    <div className="nl-canvas" style={{ ...vars, background: design.colors.page, padding: `${design.layout.outerPadding || 20}px 0` }}>
      <div className="nl-card" style={{ background: design.colors.background, borderRadius: design.layout.cardRadius, padding: cardPad, maxWidth: design.layout.contentWidth, margin: "0 auto" }}>
        {design.options.showHeader && settings.logo ? <img src={settings.logo} alt="" style={{ height: 28, marginBottom: 20 }} /> : null}

        {(mail.blocks || []).map((b, i) => (
          <BlockWrap key={b.id} edit={edit} block={b} index={i} count={mail.blocks.length} design={design}>
            <Boxed block={b} design={design}>{(d) => <BlockView block={b} design={d} edit={edit} />}</Boxed>
          </BlockWrap>
        ))}
        {edit && !edit.selectMode ? <AddBar onAdd={(t) => edit.onAdd(mail.blocks.length, t)} /> : null}

        {design.options.showFooter ? (
          <div style={{ marginTop: design.layout.spacing * 1.5, borderTop: `1px solid ${design.colors.border}`, paddingTop: design.layout.spacing, fontFamily: fontStack(design.typography.bodyFont), fontSize: 12, lineHeight: 1.5, color: design.colors.secondary }}>
            <div>{settings.publication_name}</div>
            <div style={{ marginTop: 4 }}>{settings.footer_text || `You're receiving this because you subscribed to ${settings.publication_name || "our newsletter"}.`}</div>
            <div style={{ marginTop: 4 }}><a href="#" style={{ color: design.colors.secondary, fontWeight: 600 }}>Unsubscribe</a></div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function BlockWrap({ edit, block, index, count, design, children }: { edit?: EditHandlers; block: Block; index: number; count: number; design: DesignTokens; children: React.ReactNode }) {
  // The HTML being edited, or null. A block that isn't HTML yet is converted on Save, so Cancel leaves it as it was.
  const [htmlDraft, setHtmlDraft] = useState<string | null>(null);
  if (!edit) return <div style={{ marginBottom: design.layout.spacing }}>{children}</div>;

  if (edit.selectMode) {
    const on = edit.aiSelected.has(block.id);
    return (
      <div
        onClick={(e) => { e.stopPropagation(); edit.toggleAI(block.id); }}
        className={`relative cursor-pointer rounded-md border-2 p-1 transition ${on ? "border-primary bg-primary/5" : "border-transparent hover:border-primary/40"}`}
        style={{ marginBottom: design.layout.spacing }}
      >
        {on ? <span className="absolute -left-2 -top-2 z-10 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground"><Check size={12} /></span> : null}
        {children}
      </div>
    );
  }

  const selected = edit.selectedId === block.id;
  const stylable = block.type === "heading" || block.type === "text";
  // Any block can become HTML: it starts as exactly the email markup it sends today.
  const openHtml = () => setHtmlDraft(block.type === "html" ? block.html : readable(renderBlock(block, design)));
  return (
    <div
      className={`group relative rounded-md p-0.5 transition ${selected ? "ring-2 ring-primary/40" : "hover:ring-1 hover:ring-border"}`}
      style={{ marginBottom: design.layout.spacing }}
      onClick={(e) => { e.stopPropagation(); edit.setSelected(block.id); }}
    >
      <div className={`absolute -top-3 right-2 z-10 flex items-center gap-0.5 rounded-lg border bg-background p-0.5 shadow-sm ${selected ? "" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}>
        {stylable ? <PresetMenu block={block} onPick={(p) => edit.onReplace(block.id, applyPreset(block, p))} /> : null}
        <StyleMenu block={block} design={design} onChange={(p) => edit.onBlock(block.id, p)} />
        <Tool icon={Sparkles} title="Rewrite with AI" onClick={() => edit.onBlockAI(block)} />
        <Tool icon={Code} title={block.type === "html" ? "Edit HTML" : "Edit as HTML (stops following the design settings)"} onClick={openHtml} />
        <Tool icon={ChevronUp} title="Move up" disabled={index === 0} onClick={() => edit.onMove(index, -1)} />
        <Tool icon={ChevronDown} title="Move down" disabled={index === count - 1} onClick={() => edit.onMove(index, 1)} />
        <Tool icon={Trash2} title="Delete" onClick={() => edit.onDelete(index)} />
      </div>
      {children}
      <AddBar inline onAdd={(t) => edit.onAdd(index + 1, t)} />
      {htmlDraft !== null ? (
        <HtmlEditor
          html={htmlDraft}
          design={design}
          onSave={(html) => {
            if (block.type !== "html") edit.onReplace(block.id, { id: block.id, type: "html", html });
            else if (html !== block.html) edit.onBlock(block.id, { html });
            setHtmlDraft(null);
          }}
          onClose={() => setHtmlDraft(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * One line per table row, cell and div, so converted markup is editable. Only
 * between structural tags: a break between inline tags would add a space.
 */
function readable(html: string): string {
  return html.replace(/(<\/?(?:table|tbody|tr|td|div)\b[^>]*>)(?=<)/g, "$1\n");
}

/**
 * An HTML block on the canvas. Sandboxed with scripts off, so markup a teammate
 * pasted can't run in this app. Same-origin only so the frame's height can be
 * read; without scripts that grants the frame nothing.
 */
function HtmlFrame({ html, design }: { html: string; design: DesignTokens }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(48);
  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
    `body{font-family:${fontStack(design.typography.bodyFont)};font-size:${design.typography.baseSize}px;line-height:${design.typography.lineHeight};color:${design.colors.foreground}}` +
    `img{max-width:100%}</style></head><body>${renderHtmlBlock(html)}</body></html>`;
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(Math.max(24, Math.ceil(body.scrollHeight)));
    };
    const onLoad = () => {
      measure();
      const body = frame.contentDocument?.body;
      if (body) (observer = new ResizeObserver(measure)).observe(body);
    };
    frame.addEventListener("load", onLoad);
    return () => { frame.removeEventListener("load", onLoad); observer?.disconnect(); };
  }, [doc]);
  // pointer-events off: a click selects the block, and links can't open from a sandbox anyway.
  return <iframe ref={ref} title="HTML block" sandbox="allow-same-origin" srcDoc={doc} style={{ display: "block", width: "100%", height, border: 0, pointerEvents: "none" }} />;
}

/** Code on the left, the block as it will look on the right. One save is one undo step. */
function HtmlEditor({ html, design, onSave, onClose }: { html: string; design: DesignTokens; onSave: (html: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(html);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-5xl" onClick={(e) => e.stopPropagation()}>
        <DialogHeader><DialogTitle>Edit HTML</DialogTitle></DialogHeader>
        <div className="grid min-h-[420px] gap-3 md:grid-cols-2">
          <textarea
            autoFocus
            spellCheck={false}
            aria-label="HTML"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[420px] w-full resize-none rounded-md bg-muted p-3 font-mono text-xs leading-relaxed shadow-edge outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="overflow-auto rounded-md p-3 shadow-edge" style={{ background: design.colors.background }}>
            <HtmlFrame html={draft} design={design} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Use tables and inline styles; mail clients ignore most other CSS. Scripts, forms and embeds are removed when the email is sent. Merge tags such as <code>{"{{first_name|there}}"}</code> work here too.
        </p>
        <DialogFooter>
          <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
          <Button type="button" onClick={() => onSave(draft)}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The block's coloured section on the canvas, matching the email (shared blockBox). */
function Boxed({ block, design, children }: { block: Block; design: DesignTokens; children: (d: DesignTokens) => React.ReactNode }) {
  const box = blockBox(block, design);
  if (!box) return <>{children(design)}</>;
  return <div style={{ background: box.background || undefined, padding: box.padding, borderRadius: box.radius }}>{children(box.design)}</div>;
}

const PADDINGS = [0, 16, 24, 32, 48];
const BOX_LABELS: Record<(typeof BOX_COLORS)[number], string> = { page: "Page", primary: "Accent", secondary: "Muted", foreground: "Dark", border: "Light" };

/** Section colour and padding for any block, plus the controls only images and buttons have. */
function StyleMenu({ block, design, onChange }: { block: Block; design: DesignTokens; onChange: (patch: Record<string, unknown>) => void }) {
  const box = block.box ?? {};
  const setBox = (next: typeof box) => {
    const clean = { ...next };
    if (!clean.background) delete clean.background;
    if (clean.padding === undefined) delete clean.padding;
    // Padding 0 is kept on a coloured section (it would otherwise default to 24); alone it means no box.
    onChange({ box: clean.background || clean.padding ? clean : undefined });
  };
  const chip = (active: boolean) => `h-7 rounded px-2 text-xs ${active ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button title="Style" onClick={(e) => e.stopPropagation()} className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
          <Paintbrush size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3 p-3" align="end" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Background</div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button className={chip(!box.background)} onClick={() => setBox({ ...box, background: undefined })}>None</button>
            {BOX_COLORS.map((c) => (
              <button
                key={c}
                title={BOX_LABELS[c]}
                aria-label={BOX_LABELS[c]}
                onClick={() => setBox({ ...box, background: c })}
                className={`h-7 w-7 rounded-full shadow-edge ${box.background === c ? "ring-2 ring-primary ring-offset-1" : ""}`}
                style={{ background: design.colors[c] }}
              />
            ))}
            <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full shadow-edge" title="Custom colour">
              <span className="absolute inset-0" style={{ background: box.background?.startsWith("#") ? box.background : "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }} />
              <input type="color" className="absolute inset-0 opacity-0" aria-label="Custom colour" value={box.background?.startsWith("#") ? box.background : "#F4F4F5"} onChange={(e) => setBox({ ...box, background: e.target.value.toUpperCase() })} />
            </label>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">Padding</div>
          <div className="flex gap-1">
            {PADDINGS.map((p) => (
              <button key={p} className={chip((box.padding ?? (box.background ? 24 : 0)) === p)} onClick={() => setBox({ ...box, padding: p })}>{p}</button>
            ))}
          </div>
        </div>
        {block.type === "image" ? (
          <>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Width</div>
              <div className="flex gap-1">
                {[25, 50, 75, 100].map((w) => (
                  <button key={w} className={chip((block.width ?? 100) === w)} onClick={() => onChange({ width: w === 100 && !block.align ? undefined : w })}>{w}%</button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Align</div>
              <div className="flex gap-1">
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} className={`${chip((block.align ?? "center") === a)} capitalize`} onClick={() => onChange({ align: a === "center" && !block.width ? undefined : a })}>{a}</button>
                ))}
              </div>
            </div>
          </>
        ) : null}
        {block.type === "button" ? (
          <>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Style</div>
              <div className="flex gap-1">
                <button className={chip(block.variant !== "outline")} onClick={() => onChange({ variant: undefined })}>Solid</button>
                <button className={chip(block.variant === "outline")} onClick={() => onChange({ variant: "outline" })}>Outline</button>
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Width</div>
              <div className="flex gap-1">
                <button className={chip(!block.fullWidth)} onClick={() => onChange({ fullWidth: undefined })}>Fit text</button>
                <button className={chip(!!block.fullWidth)} onClick={() => onChange({ fullWidth: true })}>Full width</button>
              </div>
            </div>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function PresetMenu({ block, onPick }: { block: Block; onPick: (p: TextPreset) => void }) {
  const cur = currentPreset(block);
  const label = TEXT_PRESETS.find((p) => p.id === cur)?.label || "Style";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" title="Text style" onClick={(e) => e.stopPropagation()}>
          {label} <ChevronsUpDown size={11} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="end">
        {TEXT_PRESETS.map((p) => (
          <button key={p.id} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${cur === p.id ? "text-primary" : ""}`} onClick={() => onPick(p.id)}>
            {p.label} {cur === p.id ? <Check size={13} /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function Tool({ icon: Icon, title, onClick, disabled }: { icon: typeof Sparkles; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button title={title} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(); }} className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30">
      <Icon size={13} />
    </button>
  );
}

function BlockView({ block, design, edit }: { block: Block; design: DesignTokens; edit?: EditHandlers }) {
  const set = (patch: Record<string, unknown>) => edit?.onBlock(block.id, patch);
  const editable = edit && !edit.selectMode;

  switch (block.type) {
    case "heading": {
      const tag = (`h${block.level}` as "h1" | "h2" | "h3");
      return editable ? (
        <Editable tag={tag} value={block.text} placeholder="Heading" style={headingStyle(block.level, design)} onCommit={(v) => set({ text: v })} />
      ) : (
        <div style={headingStyle(block.level, design)}>{block.text}</div>
      );
    }
    case "text":
      return editable ? (
        <Editable multiline value={block.md} placeholder="Write something…" style={textStyle(block, design)} onCommit={(v) => set({ md: v })} />
      ) : (
        <div style={textStyle(block, design)} dangerouslySetInnerHTML={{ __html: markdownToHtml(block.md) }} />
      );
    case "image":
      return <ImageField edit={edit} src={block.src} onCommit={(src) => set({ src })} radius={design.layout.imageRadius} caption={block.caption} onCaption={(c) => set({ caption: c })} label="image" width={block.width} align={block.align} />;
    case "button":
      return (
        <div style={{ textAlign: block.align }}>
          <span
            style={{
              display: block.fullWidth ? "block" : "inline-block",
              textAlign: "center",
              background: block.variant === "outline" ? "transparent" : design.colors.primary,
              border: block.variant === "outline" ? `2px solid ${design.colors.primary}` : undefined,
              color: block.variant === "outline" ? design.colors.primary : design.options.autoButtonText === false ? design.colors.onPrimary : readableTextOn(design.colors.primary),
              padding: block.variant === "outline" ? "10px 20px" : "12px 22px",
              borderRadius: design.layout.buttonRadius,
              fontFamily: fontStack(design.typography.bodyFont),
              fontWeight: 600,
            }}
          >
            {editable ? <Editable tag="span" value={block.text} placeholder="Button" onCommit={(v) => set({ text: v })} /> : block.text}
          </span>
          {editable ? <input className="ml-2 w-48 rounded border bg-background px-2 py-1 align-middle text-xs text-muted-foreground" value={block.href} placeholder="https://link" onChange={(e) => set({ href: e.target.value })} /> : null}
        </div>
      );
    case "list":
      return <BlockList ordered={block.ordered} items={block.items} edit={edit} design={design} onChange={(items) => set({ items })} />;
    case "quote":
      return editable ? (
        <Editable tag="blockquote" value={block.text} placeholder="Quote" style={{ margin: 0, borderLeft: `3px solid ${design.colors.primary}`, paddingLeft: 18, fontFamily: fontStack(design.typography.headingFont), fontStyle: "italic", fontSize: design.typography.baseSize + 4, color: design.colors.secondary }} onCommit={(v) => set({ text: v })} />
      ) : (
        <blockquote style={{ margin: 0, borderLeft: `3px solid ${design.colors.primary}`, paddingLeft: 18, fontStyle: "italic", color: design.colors.secondary }}>{block.text}</blockquote>
      );
    case "divider":
      return <hr style={{ border: 0, borderTop: `1px solid ${design.colors.border}`, margin: 0 }} />;
    case "spacer":
      return <div style={{ height: block.size }} className="rounded bg-muted/60" />;
    case "html":
      return <HtmlFrame html={block.html} design={design} />;
    case "columns":
      return (
        <div style={{ display: "flex", gap: 16 }}>
          {block.items.map((cell, ci) => (
            <div key={ci} style={{ flex: 1 }}>
              <ImageField edit={edit} src={cell.image} radius={design.layout.imageRadius} label="image" onCommit={(src) => set({ items: block.items.map((c, j) => (j === ci ? { ...c, image: src } : c)) })} />
              <div style={{ fontFamily: fontStack(design.typography.headingFont), fontWeight: design.typography.headingWeight, fontSize: design.typography.baseSize + 1, color: design.colors.foreground, marginTop: 8 }}>
                {editable ? <Editable value={cell.heading} placeholder="Heading" onCommit={(v) => set({ items: block.items.map((c, j) => (j === ci ? { ...c, heading: v } : c)) })} /> : cell.heading}
              </div>
              <div style={{ fontSize: design.typography.baseSize - 1, color: design.colors.secondary }}>
                {editable ? <Editable value={cell.text} placeholder="Text" onCommit={(v) => set({ items: block.items.map((c, j) => (j === ci ? { ...c, text: v } : c)) })} /> : cell.text}
              </div>
            </div>
          ))}
        </div>
      );
  }
}

function BlockList({ ordered, items, edit, design, onChange }: { ordered: boolean; items: string[]; edit?: EditHandlers; design: DesignTokens; onChange: (items: string[]) => void }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag style={{ paddingLeft: 22, margin: 0, fontFamily: fontStack(design.typography.bodyFont), fontSize: design.typography.baseSize, lineHeight: design.typography.lineHeight, color: design.colors.foreground }}>
      {items.map((it, i) => (
        <li key={i} style={{ marginBottom: 6 }}>
          <Editable
            tag="span"
            value={it}
            placeholder="List item"
            onCommit={(v) => {
              const next = items.slice();
              if (v.trim() === "") next.splice(i, 1);
              else next[i] = v;
              onChange(next.length ? next : [""]);
            }}
          />
        </li>
      ))}
      {edit && !edit.selectMode ? (
        <li style={{ listStyle: "none", marginLeft: -16 }}>
          <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange([...items, "New item"])}>+ add item</button>
        </li>
      ) : null}
    </Tag>
  );
}

function ImageField({ edit, src, onCommit, radius, label, caption, onCaption, width, align }: { edit?: EditHandlers; src: string; onCommit: (src: string) => void; radius: number; label: string; caption?: string; onCaption?: (c: string) => void; width?: number; align?: "left" | "center" | "right" }) {
  const [url, setUrl] = useState(src);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Same sizing as the email: a width or alignment turns the full-bleed image into a sized, aligned one.
  const sized = width !== undefined || align !== undefined;
  const imgStyle: CSSProperties = sized
    ? { width: `${width ?? 100}%`, maxWidth: "100%", borderRadius: radius, display: "inline-block" }
    : { width: "100%", borderRadius: radius, display: "block" };
  const frame: CSSProperties = sized ? { textAlign: align ?? "center", lineHeight: 0 } : {};

  if (!edit || edit.selectMode) {
    if (!src) return null;
    return <div style={frame}><img src={src} alt="" style={imgStyle} /></div>;
  }

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const data = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !data.url) throw new Error(data.error || "Upload failed");
      onCommit(data.url);
    } catch {
      /* ignored */
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="relative">
      <Popover>
        <PopoverTrigger asChild>
          {src ? (
            <button className="block w-full" style={frame} title={`Change ${label}`} onClick={() => setUrl(src)}>
              <img src={src} alt="" style={imgStyle} />
            </button>
          ) : (
            <button className="flex w-full items-center justify-center gap-2 border border-dashed py-8 text-sm text-muted-foreground hover:border-primary" style={{ borderRadius: radius }}>
              <ImageIcon size={16} /> Add {label}
            </button>
          )}
        </PopoverTrigger>
        <PopoverContent className="w-80" align="start">
          <div className="flex gap-2">
            <Input autoFocus placeholder="Paste image URL…" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onCommit(url)} />
            <Button size="sm" onClick={() => onCommit(url)}>Apply</Button>
          </div>
          <div className="mt-2">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button variant="outline" size="sm" className="w-full" disabled={uploading} onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> {uploading ? "Uploading…" : "Upload from computer"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {caption !== undefined && src ? (
        <Editable value={caption} placeholder="Caption (optional)" className="mt-2 text-center text-xs text-muted-foreground" onCommit={(v) => onCaption?.(v)} />
      ) : null}
    </div>
  );
}

const BLOCK_TYPES: { type: BlockType; label: string; icon: typeof Type }[] = [
  { type: "text", label: "Text", icon: Type },
  { type: "heading", label: "Heading", icon: Heading },
  { type: "image", label: "Image", icon: ImageIcon },
  { type: "button", label: "Button", icon: MousePointerClick },
  { type: "list", label: "List", icon: ListIcon },
  { type: "quote", label: "Quote", icon: Quote },
  { type: "divider", label: "Divider", icon: Minus },
  { type: "columns", label: "Columns", icon: ColumnsIcon },
  { type: "html", label: "HTML", icon: Code },
];

function AddBar({ onAdd, inline }: { onAdd: (t: BlockType) => void; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={inline ? "relative h-0" : "relative flex justify-center py-2"}>
      <div className={inline ? "absolute left-1/2 -bottom-3 z-10 -translate-x-1/2 pointer-events-none opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100" : ""}>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="grid h-6 w-6 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-primary" title="Add block" onClick={(e) => e.stopPropagation()}>
              <Plus size={14} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-2" align="center">
            <div className="grid grid-cols-2 gap-1">
              {BLOCK_TYPES.map(({ type, label, icon: Icon }) => (
                <button key={type} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { onAdd(type); setOpen(false); }}>
                  <Icon size={15} className="text-muted-foreground" /> {label}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
