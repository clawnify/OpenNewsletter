/**
 * The editor's left-sidebar assistant. A conversational surface (AI Elements +
 * AI SDK `useChat`) that streams from /api/chat. The assistant's editing tools
 * have no server execution — they arrive here as tool-calls and are applied to
 * the live mail via `applyTool`, so every change lands on the editor's undo
 * stack and the user watches blocks update as the assistant works.
 *
 * Hints are sources the assistant grounds on (GitHub commits today), attached
 * as pills above the composer and sent alongside each turn.
 */
import { useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { api } from "../api";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { Sparkles, X, Plus, ChevronDown, Wrench, Pencil, Trash2, Type, Palette, Search, BookOpen, ListChecks, FileText, Image as ImageIcon } from "lucide-react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Suggestions } from "@/components/ai-elements/suggestion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** What the assistant is told about the current newsletter each turn. */
export type ChatContext = { title?: string; outline?: string; design?: string };
/** Applies a streamed tool-call to the editor; returns a short result line. */
export type ApplyTool = (name: string, input: Record<string, unknown>) => string;

/** A source the assistant can ground on. GitHub repo only today. */
type Hint = { id: string; kind: "github"; repo: string; active: boolean };

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z" />
    </svg>
  );
}

let hintSeq = 0;

/** Upload a chat attachment (data URL) to R2 storage; returns its public URL. */
async function uploadAttachment(file: { url: string; filename?: string; mediaType?: string }): Promise<string | null> {
  try {
    const blob = await (await fetch(file.url)).blob();
    const fd = new FormData();
    fd.append("file", new File([blob], file.filename || "image.png", { type: file.mediaType || blob.type || "image/png" }));
    const r = await fetch("/api/upload", { method: "POST", body: fd });
    if (!r.ok) return null;
    const d = (await r.json()) as { url?: string };
    return d.url || null;
  } catch {
    return null;
  }
}

/** Thumbnail row for pending attachments — rendered inside PromptInput's context. */
function AttachmentPreviews() {
  const att = usePromptInputAttachments();
  if (!att.files.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {att.files.map((f) => (
        <div key={f.id} className="relative">
          {f.url ? (
            <img src={f.url} alt={f.filename || ""} className="size-12 rounded-sm object-cover shadow-edge" />
          ) : (
            <div className="size-12 rounded-sm bg-muted shadow-edge" />
          )}
          <button
            type="button"
            onClick={() => att.remove(f.id)}
            className="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full bg-foreground text-background"
            aria-label="Remove attachment"
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Chat({
  mailId,
  getContext,
  applyTool,
  available,
  selectedCount,
  onClearSelection,
}: {
  mailId: number;
  getContext: () => ChatContext;
  applyTool: ApplyTool;
  available: boolean;
  selectedCount: number;
  onClearSelection: () => void;
}) {
  // Keep the latest callbacks/state in refs — useChat captures its options once,
  // so a plain closure would freeze the first render's values.
  const ctxRef = useRef(getContext);
  ctxRef.current = getContext;
  const applyToolRef = useRef(applyTool);
  applyToolRef.current = applyTool;
  const [input, setInput] = useState("");
  // Files attached to the most recent message — uploaded on demand when the
  // assistant calls add_image.
  const lastFilesRef = useRef<{ url: string; filename?: string; mediaType?: string }[]>([]);
  const [hints, setHints] = useState<Hint[]>([]);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  // Repos the connected GITHUB_TOKEN can see — offered as a picker so the user
  // needn't type. Empty when no token; typing any public repo still works.
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    api<{ repos: { full_name: string }[] }>("GET", "/api/github/repos")
      .then((d) => setRepos(d.repos.map((r) => r.full_name)))
      .catch(() => {});
  }, []);

  const { messages, sendMessage, status, addToolOutput, setMessages } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: ({ messages }) => ({
        body: {
          messages,
          context: ctxRef.current(),
          hints: hintsRef.current.filter((h) => h.active).map(({ kind, repo }) => ({ kind, repo })),
        },
      }),
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: async ({ toolCall }) => {
      // add_image uploads the user's attachment to storage, then inserts it.
      if (toolCall.toolName === "add_image") {
        const alt = String((toolCall.input as Record<string, unknown>).alt || "");
        const images = lastFilesRef.current.filter((f) => (f.mediaType || "").startsWith("image/"));
        let added = 0;
        for (const f of images) {
          const url = await uploadAttachment(f);
          if (url) { applyToolRef.current("add_image", { src: url, alt }); added++; }
        }
        addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output: added ? `Added ${added} image(s) from your attachment.` : "No attached image to add." });
        return;
      }
      const output = applyToolRef.current(toolCall.toolName, toolCall.input as Record<string, unknown>);
      addToolOutput({ tool: toolCall.toolName, toolCallId: toolCall.toolCallId, output });
    },
  });

  // Conversation is stored 1:1 with the mail — load it, then persist on change.
  const loadedRef = useRef(false);
  useEffect(() => {
    loadedRef.current = false;
    api<{ messages: typeof messages }>("GET", `/api/mails/${mailId}/conversation`)
      .then((d) => setMessages(d.messages || []))
      .catch(() => {})
      .finally(() => { loadedRef.current = true; });
  }, [mailId]);
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      api("PUT", `/api/mails/${mailId}/conversation`, { messages }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [messages, mailId]);

  const submit = (m: PromptInputMessage) => {
    const hasFiles = (m.files?.length || 0) > 0;
    if ((!m.text?.trim() && !hasFiles) || !available) return;
    lastFilesRef.current = (m.files || []).map((f) => ({ url: f.url, filename: f.filename, mediaType: f.mediaType }));
    sendMessage({ text: m.text || "", files: m.files });
    setInput("");
  };

  const addHint = (h: Omit<Hint, "id" | "active">) => setHints((hs) => [...hs, { ...h, id: `h${++hintSeq}`, active: true }]);
  const toggleHint = (id: string) => setHints((hs) => hs.map((h) => (h.id === id ? { ...h, active: !h.active } : h)));
  const removeHint = (id: string) => setHints((hs) => hs.filter((h) => h.id !== id));

  return (
    <TooltipProvider>
      <div className="flex h-full min-w-0 flex-col bg-background">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">
          <Sparkles size={15} className="text-primary" /> Assistant
        </div>

        <Conversation className="flex-1">
          <ConversationContent className="gap-4">
            {messages.length === 0 ? (
              <ConversationEmptyState
                icon={<Sparkles size={18} className="text-primary" />}
                title="Write with the assistant"
                description={
                  available
                    ? "Describe the newsletter you want, or ask for edits to what's on the canvas."
                    : "Connect OPENROUTER_API_KEY to chat."
                }
              />
            ) : null}
            {messages.map((m) => (
              <Message key={m.id} from={m.role}>
                <MessageContent>
                  {m.parts.map((part, i) =>
                    part.type === "text" ? <MessageResponse key={i}>{part.text}</MessageResponse> : null,
                  )}
                  {m.role === "assistant" ? <MessageTools parts={m.parts as ToolPart[]} /> : null}
                </MessageContent>
              </Message>
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        {selectedCount > 0 ? (
          <div className="mx-3 mb-1 flex items-center gap-1.5 rounded-sm bg-accent-tint px-2.5 py-1.5 text-xs text-accent-text">
            <Sparkles size={12} className="text-primary" />
            <span>
              <strong>{selectedCount}</strong> block{selectedCount === 1 ? "" : "s"} in focus — edits will target them.
            </span>
            <button className="ml-auto text-muted-foreground hover:text-foreground" onClick={onClearSelection} aria-label="Clear selection">
              <X size={12} />
            </button>
          </div>
        ) : null}

        {/* Hints — sources the assistant grounds on */}
        <div className="px-3 pb-1">
          <Suggestions className="py-0.5">
            {hints.map((h) => (
              <button
                key={h.id}
                onClick={() => toggleHint(h.id)}
                title={h.active ? "Connected — recent commits ground the assistant; it can also search this repo" : "Click to include this source"}
                className={cn(
                  "group inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs transition",
                  h.active ? "border-primary bg-accent text-foreground" : "border-input bg-background text-muted-foreground",
                )}
              >
                <GithubMark className="size-3.5 shrink-0" />
                <span className="max-w-[160px] truncate">{h.repo}</span>
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); removeHint(h.id); }}
                  className="ml-0.5 opacity-40 hover:opacity-100"
                  aria-label="Remove hint"
                >
                  <X className="size-3" />
                </span>
              </button>
            ))}
            <AddHintPill onAdd={addHint} repos={repos} />
          </Suggestions>
        </div>

        <div className="px-3 pb-3">
          <PromptInput onSubmit={submit} accept="image/*" multiple globalDrop>
            <PromptInputBody>
              <AttachmentPreviews />
              <PromptInputTextarea
                value={input}
                disabled={!available}
                placeholder={available ? "Describe a newsletter, attach an image, or ask for an edit…" : "Connect OPENROUTER_API_KEY"}
                onChange={(e) => setInput(e.target.value)}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="Attach image" />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
              </PromptInputTools>
              <PromptInputSubmit disabled={!available} status={status} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Tool activity (what the assistant did this turn) ─────────────────

type ToolPart = { type: string; toolName?: string; input?: Record<string, unknown>; state?: string };
const SOURCE_TOOLS = new Set(["search_commits", "list_mails", "read_mail"]);

function describeTool(name: string, input: Record<string, unknown> = {}): { Icon: typeof Wrench; label: string } {
  switch (name) {
    case "set_content": return { Icon: FileText, label: "Rewrote the newsletter" };
    case "add_block": return { Icon: Plus, label: "Added a block" };
    case "edit_block": return { Icon: Pencil, label: "Edited a block" };
    case "remove_block": return { Icon: Trash2, label: "Removed a block" };
    case "set_title": return { Icon: Type, label: "Set the title" };
    case "set_design": return { Icon: Palette, label: `Changed ${input.key || "design"}` };
    case "add_image": return { Icon: ImageIcon, label: "Added an image" };
    case "search_commits": return { Icon: Search, label: `Searched ${input.repo || "GitHub"}` };
    case "list_mails": return { Icon: ListChecks, label: "Listed past newsletters" };
    case "read_mail": return { Icon: BookOpen, label: `Read newsletter #${input.mail_id}` };
    default: return { Icon: Wrench, label: name };
  }
}

function MessageTools({ parts }: { parts: ToolPart[] }) {
  const calls = parts
    .map((p) => (p.type === "dynamic-tool" ? p.toolName : p.type.startsWith("tool-") ? p.type.slice(5) : null))
    .map((name, i) => (name ? { name, input: parts[i].input || {} } : null))
    .filter((x): x is { name: string; input: Record<string, unknown> } => x !== null);
  if (!calls.length) return null;

  const allSources = calls.every((c) => SOURCE_TOOLS.has(c.name));
  const noSources = calls.every((c) => !SOURCE_TOOLS.has(c.name));
  const summary = allSources
    ? `Used ${calls.length} source${calls.length === 1 ? "" : "s"}`
    : noSources
      ? `${calls.length} edit${calls.length === 1 ? "" : "s"}`
      : `${calls.length} step${calls.length === 1 ? "" : "s"}`;

  return (
    <Collapsible className="mt-1.5 text-xs text-muted-foreground">
      <CollapsibleTrigger className="group flex items-center gap-1.5 font-medium hover:text-foreground">
        <Wrench className="size-3" /> {summary}
        <ChevronDown className="size-3 transition group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5 flex flex-col gap-1 pl-1">
        {calls.map((c, i) => {
          const { Icon, label } = describeTool(c.name, c.input);
          return (
            <div key={i} className="flex items-center gap-1.5">
              <Icon className="size-3 shrink-0 opacity-70" /> <span className="truncate">{label}</span>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function AddHintPill({ onAdd, repos }: { onAdd: (h: Omit<Hint, "id" | "active">) => void; repos: string[] }) {
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");

  const slug = repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  const valid = /^[\w.-]+\/[\w.-]+$/.test(slug);

  const submit = () => {
    if (!valid) return;
    onAdd({ kind: "github", repo: slug });
    setRepo("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-sm border border-dashed border-border px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground">
          <Plus className="size-3.5" /> Hint
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GithubMark className="size-4" /> GitHub source
        </div>
        <Input
          autoFocus
          placeholder={repos.length ? "Pick or type owner/repo" : "owner/repo"}
          value={repo}
          list="gh-repos"
          onChange={(e) => setRepo(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {repos.length ? (
          <datalist id="gh-repos">
            {repos.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        ) : null}
        <p className="text-xs text-muted-foreground">
          The assistant sees recent commits and can search this repo for specific changes.
        </p>
        <Button size="sm" className="w-full" disabled={!valid} onClick={submit}>
          Add source
        </Button>
      </PopoverContent>
    </Popover>
  );
}
