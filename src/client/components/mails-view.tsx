import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useStore } from "../store";
import type { Mail } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function MailsView({ openMail }: { openMail: (id: number) => void }) {
  const { mails, templates, createMail, deleteMail, setError } = useStore();
  const [picking, setPicking] = useState(false);

  const start = async (slug?: string) => {
    try {
      const mail = await createMail(slug);
      setPicking(false);
      openMail(mail.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Mail</h1>
          <p className="text-sm text-muted-foreground">Draft, design, and send your newsletter.</p>
        </div>
        <Button onClick={() => setPicking(true)}>
          <Plus size={16} /> New mail
        </Button>
      </header>

      {mails.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-12 text-center">
          <p className="text-muted-foreground">No mail yet.</p>
          <Button className="mt-3" onClick={() => setPicking(true)}>Create your first newsletter</Button>
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-2xl border bg-background">
          {mails.map((i) => (
            <MailRow key={i.id} mail={i} onOpen={() => openMail(i.id)} onDelete={() => deleteMail(i.id)} />
          ))}
        </ul>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Start from a template</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            <button
              className="rounded-xl border border-dashed p-4 text-left transition hover:border-primary hover:bg-muted"
              onClick={() => start("blank")}
            >
              <div className="font-medium">Blank</div>
              <div className="mt-1 text-xs text-muted-foreground">Start from scratch — an empty canvas with the default design.</div>
            </button>
            {templates.map((t) => (
              <button
                key={t.slug}
                className="rounded-xl border p-4 text-left transition hover:border-primary hover:bg-muted"
                onClick={() => start(t.slug)}
              >
                <div className="font-medium">{t.name}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t.description}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MailRow({ mail, onOpen, onDelete }: { mail: Mail; onOpen: () => void; onDelete: () => void }) {
  const badge =
    mail.status === "sent"
      ? "bg-green-100 text-green-700"
      : mail.status === "scheduled"
        ? "bg-amber-100 text-amber-700"
        : "bg-muted text-muted-foreground";
  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-muted">
      <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="truncate font-medium">{mail.title || "Untitled"}</div>
        <div className="truncate text-xs text-muted-foreground">{mail.subtitle || mail.eyebrow}</div>
      </button>
      <span className={`rounded-md px-2 py-0.5 text-xs font-medium capitalize ${badge}`}>{mail.status}</span>
      <button className="rounded-lg p-2 text-muted-foreground hover:bg-background hover:text-destructive" onClick={onDelete} aria-label="Delete">
        <Trash2 size={16} />
      </button>
    </li>
  );
}
