import { useState } from "react";
import { DESIGN_PANEL, FONTS, getPath, setPath, type DesignTokens, type Field, type FontKey } from "../../shared/design";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The DESIGN.md editor. Each control writes a single token via its
 * dotted path; the parent re-renders the preview from the new tokens.
 */
export function DesignPanel({ design, onChange }: { design: DesignTokens; onChange: (d: DesignTokens) => void }) {
  const [tab, setTab] = useState<"basic" | "advanced">("basic");
  const [search, setSearch] = useState("");
  const set = (path: string, value: unknown) => onChange(setPath(design, path, value));

  const groups = DESIGN_PANEL.filter((g) => g.tab === tab).map((g) => ({
    ...g,
    fields: g.fields.filter((f) => !search || f.label.toLowerCase().includes(search.toLowerCase())),
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 border-b p-3">
        <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Tabs value={tab} onValueChange={(v) => setTab(v as "basic" | "advanced")}>
          <TabsList className="w-full">
            <TabsTrigger value="basic" className="flex-1">Basic</TabsTrigger>
            <TabsTrigger value="advanced" className="flex-1">Advanced</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex-1 overflow-auto px-3 py-2">
        {groups.map((g) =>
          g.fields.length === 0 ? null : (
            <section key={g.title} className="py-2">
              <h3 className="px-1 py-2 text-[0.8125rem] font-medium text-muted-foreground">{g.title}</h3>
              <div className="space-y-1">
                {g.fields.map((f) => (
                  <Row key={f.path} field={f} value={getPath(design, f.path)} onChange={(v) => set(f.path, v)} />
                ))}
              </div>
            </section>
          ),
        )}
      </div>
    </div>
  );
}

function Row({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-1 py-1.5 hover:bg-muted">
      <label className="min-w-0 flex-1">
        <div className="truncate text-sm">{field.label}</div>
        {field.hint ? <div className="truncate text-xs text-muted-foreground">{field.hint}</div> : null}
      </label>
      <Control field={field} value={value} onChange={onChange} />
    </div>
  );
}

function Control({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  switch (field.type) {
    case "color":
      return <ColorControl value={String(value)} onChange={onChange} />;
    case "font":
      return (
        <Select value={String(value)} onValueChange={(v) => onChange(v as FontKey)}>
          <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(FONTS).map(([k, f]) => <SelectItem key={k} value={k}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      );
    case "number":
      return (
        <Input
          type="number"
          className="h-8 w-20 text-right"
          value={Number(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      );
    case "toggle":
      return <Switch checked={!!value} onCheckedChange={(v) => onChange(v)} />;
  }
}

function ColorControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-sm bg-card py-1 pl-1 pr-2 shadow-edge">
      <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-xs shadow-edge">
        <span className="absolute inset-0" style={{ background: value }} />
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={toHex(value)} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
      <input className="w-[72px] bg-transparent text-right font-mono text-xs uppercase outline-none" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function toHex(v: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
  return m ? `#${m[1]}` : "#000000";
}
