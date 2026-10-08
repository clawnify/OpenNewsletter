import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Zap, Mail, Clock, Plus, Play, Pause, Archive, Pencil, AlertTriangle,
  ChevronLeft, MoreVertical, Flag, Check, Trash2, Sparkles, Info,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// The automations (flows) screens. A flow is a short chain a contact walks once
// when they subscribe: send an email, wait, send another. v1 is linear; the
// shape mirrors Klaviyo's vertical builder (trigger -> steps -> end), drawn in
// this app's own tokens. The engine is src/server/flows.ts.

type FlowStatus = "draft" | "live" | "paused" | "archived";
interface FlowStep {
  id: string;
  kind: "email" | "delay" | "split" | "end";
  config: string;
  next_step_id: string | null;
}
interface StepStat { sent: number; skipped: number; waiting: number }
interface FlowIssue { step_id?: string; message: string }
interface Flow {
  id: string;
  name: string;
  status: FlowStatus;
  trigger_type: string;
  trigger_config: string;
  reentry: "none" | "always" | "after";
  waiting: number;
  completed: number;
  exited: number;
}
interface FlowDetail extends Flow {
  entry_step_id: string | null;
  steps: FlowStep[];
  stats: Record<string, StepStat>;
  issues: FlowIssue[];
  /** Someone has entered: the trigger's list is fixed. */
  entered: boolean;
}

function flowTone(s: FlowStatus): string {
  if (s === "live") return "bg-success-tint text-success";
  if (s === "paused") return "bg-warning-tint text-warning";
  if (s === "archived") return "bg-muted text-muted-foreground line-through";
  return "bg-muted text-muted-foreground";
}

function parse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Seconds as a short human duration: "3 days", "4 hours", "2 minutes". */
function humanDelay(seconds: number): string {
  if (seconds % 86400 === 0) { const d = seconds / 86400; return `${d} day${d === 1 ? "" : "s"}`; }
  if (seconds % 3600 === 0) { const h = seconds / 3600; return `${h} hour${h === 1 ? "" : "s"}`; }
  const m = Math.max(1, Math.round(seconds / 60)); return `${m} minute${m === 1 ? "" : "s"}`;
}

// The open automation lives in the path (/automations/<id>), so coming back
// from editing one of its emails, or reloading, lands on the same canvas.
const flowFromPath = () => window.location.pathname.match(/^\/automations\/([^/]+)/)?.[1] ?? null;

export function FlowsView({ openMail }: { openMail: (id: number) => void }) {
  const [selected, setSelectedState] = useState<string | null>(flowFromPath);
  useEffect(() => {
    const onPop = () => setSelectedState(flowFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setSelected = (id: string | null) => {
    const href = id ? `/automations/${id}` : "/automations";
    if (window.location.pathname !== href) window.history.pushState(null, "", href);
    setSelectedState(id);
  };
  if (selected) return <FlowDetailView id={selected} onBack={() => setSelected(null)} openMail={openMail} />;
  return <FlowsList onOpen={setSelected} />;
}

// ── list ────────────────────────────────────────────────────────────────────

function FlowsList({ onOpen }: { onOpen: (id: string) => void }) {
  const { setError, refreshMails, status } = useStore();
  const audiences = status?.audiences ?? [];
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [library, setLibrary] = useState(false);

  const load = useCallback(async () => {
    try { setFlows(await api<Flow[]>("GET", "/api/flows")); }
    catch (e) { setError((e as Error).message); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  const create = async (prebuilt: Prebuilt, audienceId: string) => {
    const flow = await api<Flow>("POST", "/api/flows", { prebuilt, audience_id: audienceId || undefined });
    await refreshMails(); // a prebuilt creates its step emails
    setLibrary(false);
    onOpen(flow.id);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <div>
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Automations</h1>
          <p className="text-sm text-muted-foreground">Emails that send themselves when someone subscribes.</p>
        </div>
        <Button onClick={() => setLibrary(true)}>
          <Plus size={16} /> New automation
        </Button>
      </header>

      <div className="mx-auto w-full max-w-3xl px-8 py-6">
        {flows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : flows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-12 text-center">
            <Zap size={24} className="mx-auto text-muted-foreground" />
            <p className="mt-3 font-medium">No automations yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              Start with a welcome series: greet new subscribers the moment they confirm, then follow up a few days later.
            </p>
            <Button className="mt-4" onClick={() => setLibrary(true)}>
              <Plus size={16} /> New automation
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-md bg-card shadow-edge">
            {flows.map((f) => (
              <li key={f.id}>
                <button className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted" onClick={() => onOpen(f.id)}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-[0.6rem] bg-warning-tint text-warning"><Zap size={16} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{f.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {triggerLabel(f, audiences)}{f.waiting ? ` · ${f.waiting} waiting` : ""}{f.completed ? ` · ${f.completed} completed` : ""}
                    </span>
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${flowTone(f.status)}`}>{f.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {library ? <LibraryDialog onClose={() => setLibrary(false)} onCreate={create} /> : null}
    </div>
  );
}

// ── library (Klaviyo's "Create flow": pick a starting point, preview it, create) ──

type Prebuilt = "welcome" | "blank";
type PreviewStep = { kind: "email"; title: string } | { kind: "delay"; seconds: number };
const LIBRARY: { id: Prebuilt; name: string; blurb: string; steps: PreviewStep[] }[] = [
  {
    id: "welcome",
    name: "Welcome series",
    blurb: "Greet new subscribers the moment they confirm, then follow up twice over the next week.",
    steps: [
      { kind: "email", title: "Welcome aboard" },
      { kind: "delay", seconds: 3 * 86400 },
      { kind: "email", title: "Getting the most out of this" },
      { kind: "delay", seconds: 4 * 86400 },
      { kind: "email", title: "One more thing" },
    ],
  },
  {
    id: "blank",
    name: "Build your own",
    blurb: "Start from the trigger and add emails and waits yourself.",
    steps: [],
  },
];

function LibraryDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (p: Prebuilt, audienceId: string) => Promise<void> }) {
  const { status, settings, setError } = useStore();
  const audiences = status?.audiences ?? [];
  const [pick, setPick] = useState<Prebuilt>("welcome");
  const [audienceId, setAudienceId] = useState(settings?.default_audience_id || audiences[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const chosen = LIBRARY.find((l) => l.id === pick)!;
  const listName = audiences.find((a) => a.id === audienceId)?.name;

  const create = async () => {
    setBusy(true);
    try { await onCreate(pick, audienceId); } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>Pick a starting point. Everything stays editable, and nothing sends until you turn it on.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-[1fr_1.1fr]">
          <div className="space-y-2" role="radiogroup" aria-label="Starting point">
            {LIBRARY.map((l) => (
              <button
                key={l.id}
                role="radio"
                aria-checked={pick === l.id}
                onClick={() => setPick(l.id)}
                className={`w-full rounded-md p-3 text-left transition ${pick === l.id ? "bg-card shadow-edge ring-2 ring-foreground" : "bg-muted/60 hover:bg-muted"}`}
              >
                <div className="flex items-center gap-2 font-medium">
                  {l.id === "blank" ? <Plus size={15} /> : <Sparkles size={15} />} {l.name}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{l.blurb}</div>
              </button>
            ))}
            <div className="space-y-1.5 pt-2">
              <Label>Who enters</Label>
              <Select value={audienceId} onValueChange={setAudienceId}>
                <SelectTrigger><SelectValue placeholder="Pick a list" /></SelectTrigger>
                <SelectContent>
                  {audiences.map((a) => <SelectItem key={a.id} value={a.id}>New subscribers to {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">People enter when they confirm their subscription. Imported contacts never do.</p>
            </div>
          </div>
          <div className="rounded-md bg-muted/40 p-4" aria-label={`Preview of ${chosen.name}`}>
            <MiniNode icon={<Zap size={13} />} dark>When someone subscribes{listName ? ` to ${listName}` : ""}</MiniNode>
            {chosen.steps.map((st, i) => (
              <div key={i}>
                <MiniLine />
                {st.kind === "email"
                  ? <MiniNode icon={<Mail size={13} />}>{st.title}</MiniNode>
                  : <div className="flex justify-center"><span className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-0.5 text-[0.7rem] text-muted-foreground shadow-edge"><Clock size={11} /> Wait {humanDelay(st.seconds)}</span></div>}
              </div>
            ))}
            {chosen.steps.length === 0 ? (
              <>
                <MiniLine />
                <div className="rounded-[0.5rem] border border-dashed border-border px-3 py-2 text-center text-xs text-muted-foreground">Add emails and waits on the canvas</div>
              </>
            ) : null}
            <MiniLine />
            <div className="flex justify-center"><span className="rounded-full bg-muted px-3 py-0.5 text-[0.7rem] font-medium text-muted-foreground">End</span></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy || !audienceId}>{busy ? "Creating…" : "Create automation"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MiniNode({ icon, dark, children }: { icon: ReactNode; dark?: boolean; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-[0.5rem] bg-card px-2.5 py-2 text-xs shadow-edge">
      <span className={`grid size-5 shrink-0 place-items-center rounded-full ${dark ? "bg-foreground text-background" : "bg-info-tint text-info"}`}>{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}
function MiniLine() {
  return <div className="mx-auto h-3 w-px bg-border" aria-hidden />;
}

// ── detail (the vertical canvas) ──────────────────────────────────────────────

function FlowDetailView({ id, onBack, openMail }: { id: string; onBack: () => void; openMail: (mailId: number) => void }) {
  const { setError, mails, refreshMails, status } = useStore();
  const audiences = status?.audiences ?? [];
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState<FlowStep | null>(null);

  const load = useCallback(async () => {
    try { setFlow(await api<FlowDetail>("GET", `/api/flows/${id}`)); }
    catch (e) { setError((e as Error).message); }
  }, [id, setError]);
  useEffect(() => { void load(); }, [load]);

  const setStatus = async (status: FlowStatus) => {
    setBusy(true);
    try { await api("POST", `/api/flows/${id}/status`, { status }); await load(); }
    catch (e) {
      // Turn-on refusals arrive as 400 with the alert list; reload shows them inline.
      setError((e as Error).message); await load();
    } finally { setBusy(false); }
  };

  const rename = async (name: string) => {
    setRenaming(false);
    if (!flow || name.trim() === flow.name || !name.trim()) return;
    try { await api("PATCH", `/api/flows/${id}`, { name: name.trim() }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const setAudience = async (audience_id: string) => {
    try { await api("PATCH", `/api/flows/${id}`, { audience_id }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const editDelay = async (stepId: string, seconds: number) => {
    try { await api("PATCH", `/api/flows/${id}/steps/${stepId}`, { config: { seconds } }); await load(); }
    catch (e) { setError((e as Error).message); }
  };

  const addStep = async (after: string | null, kind: "email" | "delay") => {
    try {
      await api("POST", `/api/flows/${id}/steps`, { after, kind });
      if (kind === "email") await refreshMails(); // the step made its email
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  const removeStep = async (step: FlowStep) => {
    setRemoving(null);
    try {
      await api("DELETE", `/api/flows/${id}/steps/${step.id}`);
      if (step.kind === "email") await refreshMails();
      await load();
    } catch (e) { setError((e as Error).message); }
  };

  if (!flow) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  const ordered = orderSteps(flow);
  const issuesByStep = new Map<string, string[]>();
  const flowIssues: string[] = [];
  for (const i of flow.issues) {
    if (i.step_id) issuesByStep.set(i.step_id, [...(issuesByStep.get(i.step_id) ?? []), i.message]);
    else flowIssues.push(i.message);
  }
  const ready = flow.issues.length === 0;
  const editable = flow.status !== "archived";
  const audienceId = parse<{ audience_id?: string | null }>(flow.trigger_config, {}).audience_id ?? "";
  const listName = audiences.find((a) => a.id === audienceId)?.name;

  // When each email goes out, counted from entry (Klaviyo's "Day N" under a step).
  let elapsed = 0;
  const sendsAt = new Map<string, number>();
  for (const st of ordered) {
    if (st.kind === "delay") elapsed += parse<{ seconds: number }>(st.config, { seconds: 0 }).seconds;
    else if (st.kind === "email") sendsAt.set(st.id, elapsed);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <button className="inline-flex size-8 items-center justify-center rounded-[0.5rem] text-muted-foreground hover:bg-muted" onClick={onBack} aria-label="Back">
          <ChevronLeft size={18} />
        </button>
        {renaming ? (
          <Input autoFocus defaultValue={flow.name} className="h-8 max-w-xs"
            onBlur={(e) => rename(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") rename((e.target as HTMLInputElement).value); if (e.key === "Escape") setRenaming(false); }} />
        ) : (
          <button className="group flex items-center gap-1.5" onClick={() => setRenaming(true)}>
            <h1 className="text-[1.05rem] font-semibold tracking-[-0.01em]">{flow.name}</h1>
            <Pencil size={13} className="text-muted-foreground opacity-0 transition group-hover:opacity-100" />
          </button>
        )}
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${flowTone(flow.status)}`}>{flow.status}</span>
        <div className="ml-auto flex items-center gap-2">
          {flow.status === "live" ? (
            <Button variant="outline" size="sm" onClick={() => setStatus("paused")} disabled={busy}><Pause size={15} /> Pause</Button>
          ) : flow.status !== "archived" ? (
            <Button size="sm" onClick={() => setStatus("live")} disabled={busy || !ready} title={ready ? undefined : "Fix the alerts below before turning this on"}>
              <Play size={15} /> {flow.status === "paused" ? "Resume" : "Turn on"}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="More"><MoreVertical size={16} /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {flow.status === "archived" ? (
                <DropdownMenuItem onClick={() => setStatus("draft")}>Restore to draft</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setStatus("archived")} className="text-destructive focus:text-destructive">
                  <Archive size={15} /> Archive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto bg-muted/40">
        <div className="mx-auto w-full max-w-md px-6 py-8">
          {flow.status === "live" ? (
            <div className="mb-4 flex gap-2 rounded-md bg-card px-3 py-2.5 text-xs text-muted-foreground shadow-edge">
              <Info size={14} className="mt-px shrink-0" />
              <span>Changes apply now. People already waiting keep their send time. A new email is skipped until it has a subject and content.</span>
            </div>
          ) : null}

          {/* Turn-on pre-flight alerts (flow-level) */}
          {flowIssues.length > 0 && (
            <div className="mb-4 rounded-md border border-warning/40 bg-warning-tint px-3 py-2.5 text-sm text-warning">
              <div className="flex items-center gap-1.5 font-medium"><AlertTriangle size={15} /> Before you turn this on</div>
              <ul className="mt-1 list-disc pl-5 text-xs">{flowIssues.map((m, i) => <li key={i}>{m}</li>)}</ul>
            </div>
          )}

          {/* Trigger */}
          <Card>
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-full bg-foreground text-background"><Zap size={15} /></span>
              <div className="min-w-0">
                <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">Trigger</div>
                <div className="text-sm font-medium">When someone subscribes{listName ? ` to ${listName}` : ""}</div>
              </div>
            </div>
            <div className="mt-2 space-y-1.5 pl-10 text-xs text-muted-foreground">
              {!flow.entered && editable && audiences.length > 1 ? (
                <Select value={audienceId} onValueChange={setAudience}>
                  <SelectTrigger className="h-8 text-xs" aria-label="List"><SelectValue placeholder="Pick a list" /></SelectTrigger>
                  <SelectContent>
                    {audiences.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : null}
              <div>
                {flow.reentry === "none" ? "Each person enters once, when they confirm. " : ""}
                {flow.entered ? "The list is fixed now that people have entered." : ""}
              </div>
            </div>
          </Card>

          <AddStep disabled={!editable} onAdd={(k) => addStep(null, k)} />

          {ordered.map((step) => (
            <div key={step.id}>
              <StepBlock
                step={step}
                stat={flow.stats[step.id]}
                issues={issuesByStep.get(step.id) ?? []}
                mailTitle={emailTitle(step, mails)}
                sendsAt={sendsAt.get(step.id)}
                editable={editable}
                onEditEmail={(mid) => openMail(mid)}
                onEditDelay={(secs) => editDelay(step.id, secs)}
                onRemove={() => setRemoving(step)}
              />
              <AddStep disabled={!editable} onAdd={(k) => addStep(step.id, k)} />
            </div>
          ))}

          <div className="flex justify-center">
            <span className="rounded-full bg-muted px-4 py-1 text-xs font-medium text-muted-foreground">
              <Flag size={12} className="mr-1 inline" /> End
            </span>
          </div>
        </div>
      </div>

      {removing ? (
        <RemoveStepDialog
          step={removing}
          waiting={flow.stats[removing.id]?.waiting ?? 0}
          title={emailTitle(removing, mails)}
          onCancel={() => setRemoving(null)}
          onConfirm={() => removeStep(removing)}
        />
      ) : null}
    </div>
  );
}

/** The connector between nodes, with the "+" that inserts an email or a wait there. */
function AddStep({ disabled, onAdd }: { disabled: boolean; onAdd: (kind: "email" | "delay") => void }) {
  return (
    <div className="flex flex-col items-center py-1" aria-hidden={disabled || undefined}>
      <div className="h-3 w-px bg-border" />
      {disabled ? (
        <div className="h-3 w-px bg-border" />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="grid size-6 place-items-center rounded-full bg-card text-muted-foreground shadow-edge transition hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              aria-label="Add a step here"
            >
              <Plus size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuItem onClick={() => onAdd("email")}><Mail size={15} /> Email</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAdd("delay")}><Clock size={15} /> Wait</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div className="h-3 w-px bg-border" />
    </div>
  );
}

function RemoveStepDialog({ step, waiting, title, onCancel, onConfirm }: {
  step: FlowStep; waiting: number; title: string; onCancel: () => void; onConfirm: () => void;
}) {
  const isEmail = step.kind === "email";
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEmail ? `Remove “${title}”?` : "Remove this wait?"}</DialogTitle>
          <DialogDescription>
            {isEmail ? "The email is deleted with the step. " : "People reaching this point go straight on to the next step. "}
            {waiting > 0 ? `${waiting} ${waiting === 1 ? "person is" : "people are"} waiting here and will move on to the next step.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepBlock({
  step, stat, issues, mailTitle, sendsAt, editable, onEditEmail, onEditDelay, onRemove,
}: {
  step: FlowStep; stat?: StepStat; issues: string[]; mailTitle: string; sendsAt?: number; editable: boolean;
  onEditEmail: (mailId: number) => void; onEditDelay: (seconds: number) => void; onRemove: () => void;
}) {
  const menu = editable ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="inline-flex size-7 shrink-0 items-center justify-center rounded-[0.5rem] text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Step options">
          <MoreVertical size={15} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onRemove} className="text-destructive focus:text-destructive"><Trash2 size={15} /> Remove</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  if (step.kind === "delay") {
    const cfg = parse<{ seconds: number }>(step.config, { seconds: 0 });
    return (
      <div className="flex items-center justify-center gap-0.5">
        <DelayCard seconds={cfg.seconds} onSave={onEditDelay} />
        {menu}
      </div>
    );
  }
  if (step.kind !== "email") return null; // split/end not instantiable in v1
  const cfg = parse<{ mail_id?: number }>(step.config, {});
  return (
    <div>
      <Card>
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[0.55rem] bg-info-tint text-info"><Mail size={15} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-sm font-medium">{mailTitle}</div>
              {menu}
            </div>

            {issues.length > 0 ? (
              <div className="mt-2 flex items-center gap-1.5 rounded-[0.5rem] bg-warning-tint px-2.5 py-1.5 text-xs text-warning">
                <AlertTriangle size={13} /> {issues[0]}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-success"><Check size={13} /> Ready to send</div>
            )}

            {stat && (stat.sent || stat.waiting || stat.skipped) ? (
              <div className="mt-2 flex gap-4 border-t border-border pt-2 text-xs text-muted-foreground">
                <span><span className="font-medium text-foreground">{stat.sent}</span> sent</span>
                <span><span className="font-medium text-foreground">{stat.waiting}</span> waiting</span>
                {stat.skipped ? <span><span className="font-medium text-foreground">{stat.skipped}</span> skipped</span> : null}
              </div>
            ) : null}

            <div className="mt-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!cfg.mail_id} onClick={() => cfg.mail_id && onEditEmail(cfg.mail_id)}>
                <Pencil size={13} /> Edit email
              </Button>
            </div>
          </div>
        </div>
      </Card>
      {sendsAt !== undefined ? <div className="mt-1 pl-1 text-[0.7rem] text-muted-foreground"><Zap size={10} className="mr-0.5 inline" /> {sendsAtLabel(sendsAt)}</div> : null}
    </div>
  );
}

function DelayCard({ seconds, onSave }: { seconds: number; onSave: (seconds: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [n, setN] = useState(() => initParts(seconds).n);
  const [unit, setUnit] = useState(() => initParts(seconds).unit);
  const save = () => { setEditing(false); const secs = n * unit; if (secs > 0 && secs !== seconds) onSave(secs); };
  return (
    <div className="flex items-center justify-center">
      {editing ? (
        <div className="flex items-center gap-1.5 rounded-full bg-card px-2 py-1 shadow-edge">
          <Clock size={14} className="text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Wait</span>
          <input type="number" min={1} value={n} onChange={(e) => setN(Math.max(1, Number(e.target.value)))}
            className="w-12 rounded border border-border bg-transparent px-1 py-0.5 text-xs" />
          <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="rounded border border-border bg-transparent px-1 py-0.5 text-xs">
            <option value={60}>minutes</option>
            <option value={3600}>hours</option>
            <option value={86400}>days</option>
          </select>
          <button className="rounded px-1.5 py-0.5 text-xs font-medium text-success hover:bg-success-tint" onClick={save}>Save</button>
        </div>
      ) : (
        <button className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs text-muted-foreground shadow-edge hover:text-foreground" onClick={() => setEditing(true)}>
          <Clock size={14} /> Wait {humanDelay(seconds)} <Pencil size={11} className="opacity-60" />
        </button>
      )}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-md bg-card p-3.5 shadow-edge">{children}</div>;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function initParts(seconds: number): { n: number; unit: number } {
  if (seconds % 86400 === 0) return { n: seconds / 86400, unit: 86400 };
  if (seconds % 3600 === 0) return { n: seconds / 3600, unit: 3600 };
  return { n: Math.max(1, Math.round(seconds / 60)), unit: 60 };
}

/** Order steps by walking entry -> next_step_id; falls back to array order. */
function orderSteps(flow: FlowDetail): FlowStep[] {
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const out: FlowStep[] = [];
  const seen = new Set<string>();
  let id = flow.entry_step_id;
  while (id && byId.has(id) && !seen.has(id)) {
    seen.add(id);
    const s = byId.get(id)!;
    if (s.kind !== "end") out.push(s);
    id = s.next_step_id;
  }
  // include any stragglers not reached (shouldn't happen for linear flows)
  for (const s of flow.steps) if (!seen.has(s.id) && s.kind !== "end") out.push(s);
  return out;
}

type MailLite = { id: number; title: string; status: string };
function emailTitle(step: FlowStep, mails: MailLite[]): string {
  if (step.kind !== "email") return "";
  const mid = parse<{ mail_id?: number }>(step.config, {}).mail_id;
  return mails.find((m) => m.id === mid)?.title || "Untitled email";
}

/** "Day 0" for an email sent on entry, "Day 3", or hours for sub-day waits. */
function sendsAtLabel(seconds: number): string {
  if (seconds === 0) return "Day 0, when they subscribe";
  if (seconds % 86400 === 0) return `Day ${seconds / 86400}`;
  return `${humanDelay(seconds)} after they subscribe`;
}

/** The list line for a flow in the list view. */
function triggerLabel(f: Flow, audiences: { id: string; name: string }[]): string {
  const id = parse<{ audience_id?: string | null }>(f.trigger_config, {}).audience_id;
  const name = audiences.find((a) => a.id === id)?.name;
  return name ? `When someone subscribes to ${name}` : "When someone subscribes";
}
