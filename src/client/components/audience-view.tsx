import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ResendAudience, ResendContact } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function AudienceView() {
  const { status, setError } = useStore();
  const audiences = status?.audiences || [];
  const [selected, setSelected] = useState<string>("");
  const [contacts, setContacts] = useState<ResendContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [first, setFirst] = useState("");

  useEffect(() => {
    if (!selected && audiences.length) setSelected(audiences[0].id);
  }, [audiences, selected]);

  const load = async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      setContacts(await api<ResendContact[]>("GET", `/api/audiences/${id}/contacts`));
    } catch (e) {
      setError((e as Error).message);
      setContacts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selected) load(selected);
  }, [selected]);

  const add = async () => {
    if (!email.trim()) return;
    try {
      const c = await api<ResendContact>("POST", `/api/audiences/${selected}/contacts`, { email: email.trim(), first_name: first.trim() || undefined });
      setContacts((p) => [c, ...p]);
      setEmail("");
      setFirst("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    try {
      await api("DELETE", `/api/audiences/${selected}/contacts/${id}`);
      setContacts((p) => p.filter((c) => c.id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!status?.resend_connected) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="text-2xl font-semibold">Audience</h1>
        <div className="mt-4 rounded-2xl border bg-background p-6 text-sm text-muted-foreground">
          Connect Resend to manage your audience. Add <code className="rounded bg-muted px-1">RESEND_API_KEY</code> to your
          Clawnify environment, then reload. Audiences (Resend “segments”) are the source of truth — this view reads and
          writes them directly.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Audience</h1>
          <p className="text-sm text-muted-foreground">Subscribers live in Resend. Pick an audience to manage its contacts.</p>
        </div>
        <Button variant="outline" size="icon" onClick={() => load(selected)} aria-label="Refresh">
          <RefreshCw size={16} />
        </Button>
      </header>

      <div className="mb-4 w-72">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger>
            <SelectValue placeholder={audiences.length ? "Select audience" : "No audiences — create one in Resend"} />
          </SelectTrigger>
          <SelectContent>
            {audiences.map((a: ResendAudience) => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-4 flex gap-2 rounded-xl border bg-background p-3">
        <Input placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input className="w-40" placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
        <Button disabled={!selected || !email.trim()} onClick={add}>
          <Plus size={15} /> Add
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-background">
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : contacts.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No contacts in this audience yet.</div>
        ) : (
          <ul className="divide-y">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{c.email}</div>
                  {c.first_name || c.last_name ? (
                    <div className="truncate text-xs text-muted-foreground">{[c.first_name, c.last_name].filter(Boolean).join(" ")}</div>
                  ) : null}
                </div>
                {c.status && c.status !== "subscribed" ? (
                  <span
                    className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
                    title={
                      c.status === "pending"
                        ? "Signed up but hasn't confirmed — not included in sends"
                        : c.status === "bounced"
                          ? "Delivery failed permanently"
                          : "Unsubscribed"
                    }
                  >
                    {c.status === "pending" ? "Pending" : c.status === "bounced" ? "Bounced" : "Unsub"}
                  </span>
                ) : null}
                <button className="rounded-lg p-2 text-muted-foreground hover:text-destructive" onClick={() => remove(c.id)} aria-label="Remove contact">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
