import { Plus, Send, Clock, FileText, Users, ChevronRight, Mail } from "lucide-react";
import { useStore } from "../store";
import { Button } from "@/components/ui/button";
import type { Mail as MailType } from "../../shared/types";

// The overview (DESIGN.md → Interaction / Signature 6): a row of stat tiles,
// tinted only where the stat is itself a status, then two cards of rows. It is
// the entry point, so the empty state offers the next step rather than "No data".
export function HomeView({
  openMail,
  onNavigate,
}: {
  openMail: (id: number) => void;
  onNavigate: (view: "mail" | "templates" | "audience" | "settings") => void;
}) {
  const { mails, templates, status, createMail, setError } = useStore();

  const sent = mails.filter((m) => m.status === "sent");
  const scheduled = mails.filter((m) => m.status === "scheduled");
  const drafts = mails.filter((m) => m.status === "draft");
  const audiences = status?.audiences ?? [];
  const subscribers = audiences.reduce((n, a) => n + (a.subscribed_count ?? 0), 0);
  const recent = [...mails].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);

  const newMail = async () => {
    const slug = templates[0]?.slug;
    if (!slug) { onNavigate("templates"); return; }
    try {
      const mail = await createMail(slug);
      openMail(mail.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const tiles: Array<{ label: string; value: number; icon: typeof Send; tone: string; ring: string }> = [
    { label: "Sent", value: sent.length, icon: Send, tone: "bg-success-tint text-success", ring: "inset 0 0 0 1px var(--success-solid)" },
    { label: "Scheduled", value: scheduled.length, icon: Clock, tone: "bg-info-tint text-info", ring: "inset 0 0 0 1px var(--info-solid)" },
    { label: "Drafts", value: drafts.length, icon: FileText, tone: "bg-card text-foreground", ring: "var(--edge-rest)" },
    { label: "Subscribers", value: subscribers, icon: Users, tone: "bg-card text-foreground", ring: "var(--edge-rest)" },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Home</h1>
        <Button onClick={newMail}><Plus size={16} /> New mail</Button>
      </header>

      <div className="mx-auto w-full max-w-5xl px-8 py-6">
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          {tiles.map(({ label, value, icon: Icon, tone, ring }) => (
            <div key={label} className={`relative rounded-md px-3 py-2.5 ${tone}`} style={{ boxShadow: ring }}>
              <Icon size={14} className="absolute right-2.5 top-2.5 opacity-50" />
              <div className="text-[1.25rem] font-semibold leading-none tabular-nums">{value}</div>
              <div className="mt-1 text-[0.8125rem] opacity-70">{label}</div>
            </div>
          ))}
        </div>

        {mails.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Mail size={40} className="mb-4 text-faint" />
            <h2 className="text-lg font-semibold">Write your first newsletter</h2>
            <p className="mt-1 max-w-md text-muted-foreground">
              Pick a template and the assistant drafts the issue; edit anything in place, then send it to an audience.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <Button onClick={newMail}><Plus size={16} /> New mail</Button>
              <Button variant="outline" onClick={() => onNavigate("templates")}>Browse templates</Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-md bg-card p-5 shadow-edge">
              <button type="button" className="group mb-2 flex items-center gap-1" onClick={() => onNavigate("mail")}>
                <span className="text-[1.0625rem] font-semibold leading-tight">Recent mails</span>
                <ChevronRight size={16} className="text-faint transition-colors group-hover:text-foreground" />
              </button>
              <ul className="-mx-3">
                {recent.map((m) => <MailRow key={m.id} mail={m} onOpen={() => openMail(m.id)} />)}
              </ul>
            </section>

            <section className="rounded-md bg-card p-5 shadow-edge">
              <button type="button" className="group mb-2 flex items-center gap-1" onClick={() => onNavigate("audience")}>
                <span className="text-[1.0625rem] font-semibold leading-tight">Audience</span>
                <ChevronRight size={16} className="text-faint transition-colors group-hover:text-foreground" />
              </button>
              {audiences.length === 0 ? (
                <p className="text-sm text-faint">No audiences yet. Connect Resend in Settings.</p>
              ) : (
                <ul className="-mx-3">
                  {audiences.map((a) => (
                    <li key={a.id} className="flex h-12 items-center gap-3 px-3 [&+li]:border-t [&+li]:border-border">
                      <Users size={16} className="text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                      <span className="tabular-nums text-sm text-muted-foreground">{a.subscribed_count ?? 0}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function MailRow({ mail, onOpen }: { mail: MailType; onOpen: () => void }) {
  const badge =
    mail.status === "sent" ? "bg-success-tint text-success"
    : mail.status === "scheduled" ? "bg-info-tint text-info"
    : "bg-muted text-muted-foreground";
  return (
    <li className="[&+li]:border-t [&+li]:border-border">
      <button type="button" onClick={onOpen} className="flex h-12 w-full items-center gap-3 rounded-[0.5rem] px-3 text-left hover:bg-muted">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{mail.title || "Untitled"}</span>
          <span className="block truncate text-xs text-muted-foreground">{mail.subtitle || mail.eyebrow}</span>
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${badge}`}>{mail.status}</span>
      </button>
    </li>
  );
}
