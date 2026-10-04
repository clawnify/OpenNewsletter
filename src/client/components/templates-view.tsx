import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Template } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function TemplatesView({ openMail }: { openMail: (id: number) => void }) {
  const { templates, createMail, refreshTemplates, refreshMails, setError } = useStore();
  const [tab, setTab] = useState<"library" | "saved">("library");

  const use = async (slug: string) => {
    try {
      const mail = await createMail(slug);
      openMail(mail.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async (slug: string) => {
    try {
      await api("DELETE", `/api/templates/${slug}`);
      // Mails that showed this template now carry a copy of its design.
      await Promise.all([refreshTemplates(), refreshMails()]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shown = templates.filter((t) => (tab === "library" ? t.builtin : !t.builtin));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-6">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Templates</h1>
        <Tabs value={tab} onValueChange={(v) => setTab(v as "library" | "saved")}>
          <TabsList variant="line">
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="saved">Saved</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-6xl px-8 py-6">
          {shown.length === 0 ? (
            <div className="rounded-md p-10 text-center text-sm text-muted-foreground shadow-edge">
              No saved templates yet. In the editor, choose <strong className="font-medium text-foreground">Save as…</strong> to keep any mail as a template.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map((t) => (
                <Card key={t.slug} template={t} onUse={() => use(t.slug)} onDelete={() => remove(t.slug)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Card({ template, onUse, onDelete }: { template: Template; onUse: () => void; onDelete: () => void }) {
  return (
    <div className="group flex flex-col overflow-hidden rounded-md bg-card shadow-edge">
      {/* A sunken well with the email rising out of it: padded top and sides, cut off at the bottom. */}
      <button type="button" onClick={onUse} className="block bg-muted px-5 pt-5 text-left" aria-label={`Use ${template.name}`}>
        <Miniature slug={template.slug} name={template.name} />
      </button>
      <div className="flex flex-1 flex-col border-t border-border p-4">
        <h3 className="font-medium">{template.name}</h3>
        <p className="mt-1 line-clamp-2 flex-1 text-xs text-muted-foreground">{template.description}</p>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onUse}>Use template</Button>
          {!template.builtin ? (
            <Button variant="outline" size="icon" onClick={onDelete} aria-label="Delete template">
              <Trash2 size={15} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The width the email is laid out at before it is scaled down to the card. */
const EMAIL_WIDTH = 640;

/**
 * The real email the template starts, shrunk to the card. Sandboxed with
 * nothing allowed: it is only a picture, and a template may hold HTML blocks.
 */
function Miniature({ slug, name }: { slug: string; name: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / EMAIL_WIDTH);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="relative h-72 overflow-hidden rounded-t-sm bg-background shadow-edge transition-transform duration-200 group-hover:-translate-y-1">
      {scale > 0 ? (
        <iframe
          title={`${name} preview`}
          src={`/api/templates/${encodeURIComponent(slug)}/preview`}
          sandbox=""
          scrolling="no"
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
          style={{ width: EMAIL_WIDTH, height: 288 / scale, transform: `scale(${scale})` }}
        />
      ) : null}
    </div>
  );
}
