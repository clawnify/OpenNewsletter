import { Trash2 } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import { FONTS, type DesignTokens } from "../../shared/design";
import type { Template } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function TemplatesView({ openMail }: { openMail: (id: number) => void }) {
  const { templates, createMail, refreshTemplates, setError } = useStore();

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
      await refreshTemplates();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-6">
        <h1 className="text-[1.375rem] font-semibold tracking-[-0.01em]">Template library</h1>
        <p className="text-sm text-muted-foreground">
          A template is a DESIGN.md look + a content skeleton. “Save as…” in the editor adds your own.
        </p>
      </header>
      <div className="mx-auto w-full max-w-5xl px-8 py-6">

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {templates.map((t) => (
          <Card key={t.slug} template={t} onUse={() => use(t.slug)} onDelete={() => remove(t.slug)} />
        ))}
      </div>
      </div>
    </div>
  );
}

function Card({ template, onUse, onDelete }: { template: Template; onUse: () => void; onDelete: () => void }) {
  const d = template.design as DesignTokens;
  return (
    <div className="flex flex-col overflow-hidden rounded-md bg-card shadow-edge">
      {/* A sunken well, then the email as a sheet with its own edge: the preview is
          the template's design, the well and the card are ours. */}
      <div className="bg-muted p-5">
        <div className="mx-auto shadow-edge" style={{ maxWidth: 260, background: d.colors.background, borderRadius: d.layout.cardRadius, padding: 16 }}>
          <div style={{ color: d.colors.primary, fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
            {template.skeleton.eyebrow || "NEWSLETTER"}
          </div>
          <div style={{ color: d.colors.foreground, fontFamily: FONTS[d.typography.headingFont].stack, fontSize: 18, fontWeight: d.typography.headingWeight, lineHeight: 1.15, marginTop: 6 }}>
            {template.skeleton.title || template.name}
          </div>
          <div className="mt-3 flex gap-1.5">
            {[d.colors.background, d.colors.foreground, d.colors.primary, d.colors.secondary, d.colors.link].map((c, i) => (
              <span key={i} className="h-4 w-4 rounded-full border border-black/10" style={{ background: c }} />
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-1 flex-col border-t border-border p-4">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{template.name}</h3>
          {template.builtin ? <Badge variant="secondary" className="text-xs">Built-in</Badge> : null}
        </div>
        <p className="mt-1 flex-1 text-xs text-muted-foreground">{template.description}</p>
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
