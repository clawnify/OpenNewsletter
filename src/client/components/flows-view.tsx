import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Zap, Mail, Clock, Plus, Play, Pause, Archive, Pencil, AlertTriangle,
  ChevronLeft, MoreVertical, Flag, Check,
} from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

export function FlowsView({ openMail }: { openMail: (id: number) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (selected) return <FlowDetailView id={selected} onBack={() => setSelected(null)} openMail={openMail} />;
  return <FlowsList onOpen={setSelected} />;
}

// ── list ────────────────────────────────────────────────────────────────────

function FlowsList({ onOpen }: { onOpen: (id: string) => void }) {
  const { setError, refreshMails } = useStore();
  const [flows, setFlows] = useState<Flow[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try { setFlows(await api<Flow[]>("GET", "/api/flows")); }
    catch (e) { setError((e as Error).message); }
  }, [setError]);
  useEffect(() => { void load(); }, [load]);

  const createWelcome = async () => {
    setCreating(true);
    try {
      const flow = await api<Flow>("POST", "/api/flows", { prebuilt: "welcome" });
      await refreshMails(); // the prebuilt created the step emails
      onOpen(flow.id);
    } catch (e) { setError((e as Error).message); } finally { setCreating(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <div>
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Automations</h1>
          <p className="text-sm text-muted-foreground">Emails that send themselves when someone subscribes.</p>
        </div>
        <Button onClick={createWelcome} disabled={creating}>
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
            <Button className="mt-4" onClick={createWelcome} disabled={creating}>
              <Plus size={16} /> Create a welcome series
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
                      When someone subscribes{f.waiting ? ` · ${f.waiting} waiting` : ""}{f.completed ? ` · ${f.completed} completed` : ""}
                    </span>
                  </span>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${flowTone(f.status)}`}>{f.status}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── detail (the vertical canvas) ──────────────────────────────────────────────

function FlowDetailView({ id, onBack, openMail }: { id: string; onBack: () => void; openMail: (mailId: number) => void }) {
  const { setError, mails } = useStore();
  const [flow, setFlow] = useState<FlowDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);

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

  const editDelay = async (stepId: string, seconds: number) => {
    try { await api("PATCH", `/api/flows/${id}/steps/${stepId}`, { config: { seconds } }); await load(); }
    catch (e) { setError((e as Error).message); }
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
              <Button variant="ghost" size="icon" className="size-8"><MoreVertical size={16} /></Button>
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
              <div>
                <div className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground">Trigger</div>
                <div className="text-sm font-medium">When someone subscribes</div>
              </div>
            </div>
            {flow.reentry === "none" && <div className="mt-2 pl-10 text-xs text-muted-foreground">Each person enters once.</div>}
          </Card>

          {ordered.map((step) => (
            <StepBlock
              key={step.id}
              step={step}
              stat={flow.stats[step.id]}
              issues={issuesByStep.get(step.id) ?? []}
              mailTitle={emailTitle(step, mails)}
              mailStatus={emailStatus(step, mails)}
              onEditEmail={(mid) => openMail(mid)}
              onEditDelay={(secs) => editDelay(step.id, secs)}
            />
          ))}

          <Connector />
          <div className="flex justify-center">
            <span className="rounded-full bg-muted px-4 py-1 text-xs font-medium text-muted-foreground">
              <Flag size={12} className="mr-1 inline" /> End
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepBlock({
  step, stat, issues, mailTitle, mailStatus, onEditEmail, onEditDelay,
}: {
  step: FlowStep; stat?: StepStat; issues: string[]; mailTitle: string; mailStatus: string | null;
  onEditEmail: (mailId: number) => void; onEditDelay: (seconds: number) => void;
}) {
  if (step.kind === "delay") {
    const cfg = parse<{ seconds: number }>(step.config, { seconds: 0 });
    return (
      <>
        <Connector />
        <DelayCard seconds={cfg.seconds} onSave={onEditDelay} />
      </>
    );
  }
  if (step.kind !== "email") return null; // split/end not instantiable in v1
  const cfg = parse<{ mail_id?: number }>(step.config, {});
  return (
    <>
      <Connector />
      <Card>
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[0.55rem] bg-info-tint text-info"><Mail size={15} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate text-sm font-medium">{mailTitle}</div>
              {mailStatus && <span className="shrink-0 text-[0.7rem] capitalize text-muted-foreground">{mailStatus}</span>}
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
                <Pencil size={13} /> Edit newsletter
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </>
  );
}

function DelayCard({ seconds, onSave }: { seconds: number; onSave: (seconds: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [n, setN] = useState(() => initParts(seconds).n);
  const [unit, setUnit] = useState(() => initParts(seconds).unit);
  const save = () => { setEditing(false); const secs = n * unit; if (secs > 0 && secs !== seconds) onSave(secs); };
  return (
    <div className="mx-auto flex max-w-[16rem] items-center justify-center">
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

function Connector() {
  return (
    <div className="flex flex-col items-center py-1.5" aria-hidden>
      <div className="h-5 w-px bg-border" />
    </div>
  );
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
  return mails.find((m) => m.id === mid)?.title || "Untitled newsletter";
}
function emailStatus(step: FlowStep, mails: MailLite[]): string | null {
  if (step.kind !== "email") return null;
  const mid = parse<{ mail_id?: number }>(step.config, {}).mail_id;
  return mails.find((m) => m.id === mid)?.status ?? null;
}
