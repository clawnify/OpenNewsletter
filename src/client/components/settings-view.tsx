import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Trash2, AppWindow } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import type { Settings, Sender, ConnectedApp } from "../../shared/types";
import { sendableStatus } from "../../shared/sending-domain";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export function SettingsView() {
  const { settings, status, saveSettings, refreshStatus, setError } = useStore();
  const [form, setForm] = useState<Settings>(
    settings || { publication_name: "", logo: "", from_name: "", from_email: "", senders: [], default_audience_id: null, footer_text: "", crm_app_id: null },
  );
  const [savedAt, setSavedAt] = useState(false);
  const [domains, setDomains] = useState<{ name: string; status: string }[]>([]);
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[] | null>(null);
  useEffect(() => {
    api<{ domains: { name: string; status: string }[] }>("GET", "/api/senders").then((d) => setDomains(d.domains || [])).catch(() => {});
    api<{ apps: ConnectedApp[] }>("GET", "/api/connected-apps").then((d) => setConnectedApps(d.apps || [])).catch(() => setConnectedApps([]));
  }, []);

  const save = async () => {
    try {
      await saveSettings(form);
      setSavedAt(true);
      setTimeout(() => setSavedAt(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Picking a contacts source applies on click (not on the Save button): it's a
  // switch, not a form field. Only one sibling can be the source, so turning one
  // on clears the others; turning the current one off sets null. Persist with
  // the rest of the current form so an unsaved edit above isn't lost, then
  // refresh status so "Import from CRM" appears or disappears immediately.
  const pickCrm = async (appId: string | null) => {
    const prev = form.crm_app_id;
    setForm((f) => ({ ...f, crm_app_id: appId }));
    try {
      await saveSettings({ crm_app_id: appId });
      await refreshStatus();
    } catch (e) {
      setForm((f) => ({ ...f, crm_app_id: prev }));
      setError((e as Error).message);
    }
  };

  const field = (label: string, key: keyof Settings, placeholder = "", type = "text") => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        placeholder={placeholder}
        value={String((form as unknown as Record<string, unknown>)[key] ?? "")}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-6">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Settings</h1>
      </header>
      <div className="mx-auto w-full max-w-2xl px-8 py-6">

      <section className="mt-6 space-y-2 rounded-md bg-card p-5 shadow-edge">
        <h2 className="text-sm font-semibold">Connections</h2>
        <Status ok={!!status?.resend_connected} label="Resend" detail={status?.resend_connected ? "Connected" : "Connect Resend in your Clawnify dashboard (Settings → Integrations), or set RESEND_API_KEY"} />
        <Status ok={!!status?.ai_available} label="AI generation (OpenRouter)" detail={status?.ai_available ? "Ready" : "Set OPENROUTER_API_KEY to enable Generate"} />
        <Status
          ok={!!status?.github_connected}
          label="GitHub (Hints)"
          detail={
            status?.github_connected
              ? "Connected — your repos appear when adding a hint"
              : "Set GITHUB_TOKEN in your Clawnify environment (Contents: read) to list private repos. Public repos work without it."
          }
        />
      </section>

      <section className="mt-6 space-y-3 rounded-md bg-card p-5 shadow-edge">
        <h2 className="text-sm font-semibold">Connected apps</h2>
        <p className="text-xs text-muted-foreground">
          Apps in this workspace that can be your contacts source. Turn one on to import from it (with recorded consent) in the Audience view — nothing syncs on its own, and only one can be the source at a time.
        </p>
        {connectedApps === null ? (
          <p className="text-xs text-muted-foreground">Looking for a contacts app in this workspace…</p>
        ) : connectedApps.length === 0 ? (
          <p className="text-xs text-muted-foreground">No app here provides contacts yet. A CRM declares this with <code className="rounded bg-muted px-1">provides: ["contacts"]</code>.</p>
        ) : (
          <div className="space-y-1.5">
            {connectedApps.map((app) => {
              const on = form.crm_app_id === app.id;
              return (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => pickCrm(on ? null : app.id)}
                  aria-pressed={on}
                  className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left shadow-edge transition hover:bg-muted"
                >
                  <AppGlyph svg={app.icon_svg} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{app.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {on ? "Contacts source — import from it in the Audience view" : "Pick as your contacts source"}
                    </div>
                  </div>
                  {/* Visual state only — the whole card is the control. */}
                  <Switch checked={on} aria-hidden tabIndex={-1} className="pointer-events-none" />
                </button>
              );
            })}
          </div>
        )}
      </section>

      <TrackingSection />

      <section className="mt-6 space-y-4 rounded-md bg-card p-5 shadow-edge">
        <h2 className="text-sm font-semibold">Sender</h2>
        {field("Publication name", "publication_name", "The Editorial Review")}
        {field("Logo URL", "logo", "https://…/logo.png")}
        <div className="grid grid-cols-2 gap-4">
          {field("From name", "from_name", "Jane from Acme")}
          {field("From email", "from_email", "hello@yourdomain.com", "email")}
        </div>
        <p className="text-xs text-muted-foreground">The from address must be on a domain you've verified in Resend.</p>

        <div className="space-y-1.5">
          <Label>Default audience</Label>
          <Select
            value={form.default_audience_id || "none"}
            onValueChange={(v) => setForm({ ...form, default_audience_id: v === "none" ? null : v })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {(status?.audiences || []).map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {field("Footer text", "footer_text", "123 Main St · You can unsubscribe anytime.")}
      </section>

      <section className="mt-6 space-y-3 rounded-md bg-card p-5 shadow-edge">
        <h2 className="text-sm font-semibold">Senders</h2>
        <p className="text-xs text-muted-foreground">From-addresses you can send and test from. The domain must be verified in Resend.</p>
        {form.senders.length ? (
          <div className="space-y-1.5">
            {form.senders.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded-sm shadow-edge px-3 py-2 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">{s.email}</span>
                <button className="ml-auto text-muted-foreground hover:text-destructive" onClick={() => setForm({ ...form, senders: form.senders.filter((_, j) => j !== i) })} aria-label="Remove sender">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No senders yet — add one below.</p>
        )}
        <AddSender domains={domains} onAdd={(s) => setForm({ ...form, senders: [...form.senders, s] })} />
      </section>

      <div className="mt-5 flex items-center gap-3">
        <Button onClick={save}>Save settings</Button>
        {savedAt ? <span className="text-sm text-success">Saved</span> : null}
      </div>
      </div>
    </div>
  );
}

function AddSender({ domains, onAdd }: { domains: { name: string; status: string }[]; onAdd: (s: Sender) => void }) {
  const verified = domains.filter((d) => sendableStatus(d.status));
  const [name, setName] = useState("");
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState("");

  if (!verified.length) {
    return <p className="text-xs text-warning">Verify a domain in Resend to add a sender.</p>;
  }
  const valid = name.trim() && /^[\w.+-]+$/.test(local.trim()) && domain;
  const add = () => {
    if (!valid) return;
    onAdd({ name: name.trim(), email: `${local.trim()}@${domain}` });
    setName(""); setLocal(""); setDomain("");
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[140px] flex-1 space-y-1">
        <Label className="text-xs">Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane from Acme" />
      </div>
      <div className="min-w-[220px] flex-[2] space-y-1">
        <Label className="text-xs">Address</Label>
        <div className="flex items-center gap-1">
          <Input value={local} onChange={(e) => setLocal(e.target.value)} placeholder="hello" />
          <span className="text-muted-foreground">@</span>
          <Select value={domain} onValueChange={setDomain}>
            <SelectTrigger className="w-[150px]"><SelectValue placeholder="domain" /></SelectTrigger>
            <SelectContent>
              {verified.map((d) => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button size="sm" disabled={!valid} onClick={add}>Add</Button>
    </div>
  );
}

// A sibling app's icon: its own inline SVG (from the app directory), else a
// generic glyph. The SVG is the app's declared icon.svg, served by the platform
// directory — same first-party source the dashboard renders inline.
function AppGlyph({ svg }: { svg: string | null }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-[0.55rem] bg-muted text-muted-foreground [&_svg]:size-5">
      {svg ? <span className="contents" dangerouslySetInnerHTML={{ __html: svg }} /> : <AppWindow size={16} />}
    </span>
  );
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 size={17} className="text-success" /> : <XCircle size={17} className="text-muted-foreground" />}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">— {detail}</span>
    </div>
  );
}

/**
 * Delivery tracking: Resend tells the app when a message bounces or is marked
 * as spam. "Turn on" registers the webhook with the key the app already sends
 * with; a sending-only key can't, so the fallback shows what to set up by hand.
 */
function TrackingSection() {
  const { status, refreshStatus, setError } = useStore();
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ endpoint: string; events: string[]; reason: string } | null>(null);
  const [secret, setSecret] = useState("");
  const tracking = status?.tracking;

  const turnOn = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/tracking");
      await refreshStatus();
    } catch (e) {
      // Only a key that can't manage webhooks gets the by-hand steps; anything
      // else (no public address yet, Resend down) is an error to read, not a
      // setup to follow.
      const data = (e as Error & { data?: { error?: string; manual?: { endpoint: string; events: string[] } } }).data;
      if (data?.manual) setManual({ ...data.manual, reason: data.error ?? "" });
      else setError(data?.error ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    try {
      await api("PUT", "/api/tracking/secret", { secret });
      setManual(null);
      setSecret("");
      await refreshStatus();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="mt-6 space-y-3 rounded-md bg-card p-5 shadow-edge">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold">Delivery tracking</h2>
        {tracking?.enabled ? (
          <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={14} /> On</span>
        ) : status?.resend_connected ? (
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={turnOn}>
            {busy ? "Turning on…" : "Turn on"}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {tracking?.enabled
          ? "Addresses that hard-bounce or mark an issue as spam stop getting your newsletter, on every list. Each sent issue shows deliveries, clicks and bounces."
          : "Resend can tell this app when a message bounces or is marked as spam, so dead and unhappy addresses stop being mailed. It also fills in deliveries and clicks for each issue."}
      </p>
      {manual ? (
        <div className="space-y-2 rounded-sm bg-muted p-3 text-xs">
          <p>{manual.reason} Add the webhook in Resend (Webhooks → Add endpoint), then paste its signing secret here.</p>
          <p><span className="text-muted-foreground">Endpoint </span><code className="break-all">{manual.endpoint}</code></p>
          <p><span className="text-muted-foreground">Events </span><code>{manual.events.join(", ")}</code></p>
          <div className="flex gap-2">
            <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" aria-label="Signing secret" />
            <Button size="sm" disabled={!secret.trim()} onClick={saveSecret}>Save</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
