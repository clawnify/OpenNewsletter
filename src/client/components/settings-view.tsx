import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Trash2 } from "lucide-react";
import { useStore } from "../store";
import { api } from "../api";
import type { Settings, Sender } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function SettingsView() {
  const { settings, status, saveSettings, setError } = useStore();
  const [form, setForm] = useState<Settings>(
    settings || { publication_name: "", logo: "", from_name: "", from_email: "", senders: [], default_audience_id: null, footer_text: "" },
  );
  const [savedAt, setSavedAt] = useState(false);
  const [domains, setDomains] = useState<{ name: string; status: string }[]>([]);
  useEffect(() => {
    api<{ domains: { name: string; status: string }[] }>("GET", "/api/senders").then((d) => setDomains(d.domains || [])).catch(() => {});
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
    <div className="mx-auto max-w-2xl px-8 py-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="mt-6 space-y-2 rounded-2xl border bg-background p-5">
        <h2 className="text-sm font-semibold">Connections</h2>
        <Status ok={!!status?.resend_connected} label="Resend" detail={status?.resend_connected ? `${status.audiences.length} audience(s)` : "Connect Resend in your Clawnify dashboard (Settings → Integrations), or set RESEND_API_KEY"} />
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

      <section className="mt-6 space-y-4 rounded-2xl border bg-background p-5">
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

      <section className="mt-6 space-y-3 rounded-2xl border bg-background p-5">
        <h2 className="text-sm font-semibold">Senders</h2>
        <p className="text-xs text-muted-foreground">From-addresses you can send and test from. The domain must be verified in Resend.</p>
        {form.senders.length ? (
          <div className="space-y-1.5">
            {form.senders.map((s, i) => (
              <div key={i} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="font-medium">{s.name}</span>
                <span className="text-muted-foreground">{s.email}</span>
                <button className="ml-auto text-muted-foreground hover:text-red-600" onClick={() => setForm({ ...form, senders: form.senders.filter((_, j) => j !== i) })} aria-label="Remove sender">
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
        {savedAt ? <span className="text-sm text-green-600">Saved</span> : null}
      </div>
    </div>
  );
}

function AddSender({ domains, onAdd }: { domains: { name: string; status: string }[]; onAdd: (s: Sender) => void }) {
  const verified = domains.filter((d) => d.status === "verified");
  const [name, setName] = useState("");
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState("");

  if (!verified.length) {
    return <p className="text-xs text-amber-600">Verify a domain in Resend to add a sender.</p>;
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

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? <CheckCircle2 size={17} className="text-green-600" /> : <XCircle size={17} className="text-muted-foreground" />}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">— {detail}</span>
    </div>
  );
}
