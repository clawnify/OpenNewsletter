import { useCallback, useEffect, useState } from "react";
import { AppNav, reportLocation, type AppNavItem } from "@clawnify/app/client";
import { StoreProvider, useStore } from "./store";
import { MailsView } from "./components/mails-view";
import { TemplatesView } from "./components/templates-view";
import { AudienceView } from "./components/audience-view";
import { SettingsView } from "./components/settings-view";
import { Editor } from "./components/editor";

export type View = "mail" | "templates" | "audience" | "settings";

// One definition of the navigation. <AppNav> paints it as this app's own
// sidebar when opened directly, and hands it to the Clawnify dashboard's
// sidebar when embedded there. Each view has a path so a reload, and the
// dashboard, land on the same screen.
const NAV: (AppNavItem & { view: View })[] = [
  { id: "mail", view: "mail", label: "Mail", href: "/", icon: "mail", home: true },
  { id: "templates", view: "templates", label: "Templates", href: "/templates", icon: "layout-grid" },
  { id: "audience", view: "audience", label: "Audience", href: "/audience", icon: "users" },
  { id: "settings", view: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

function viewFromPath(pathname: string): View {
  return NAV.find((n) => n.href !== "/" && pathname.startsWith(n.href!))?.view ?? "mail";
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const { loading, error, setError, status } = useStore();
  const [view, setView] = useState<View>(() => viewFromPath(window.location.pathname));
  const [editing, setEditing] = useState<number | null>(null);

  const navigate = useCallback((v: View) => {
    const href = NAV.find((n) => n.view === v)?.href ?? "/";
    if (window.location.pathname !== href) window.history.pushState(null, "", href);
    setView(v);
    setEditing(null);
  }, []);

  useEffect(() => {
    const onPop = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Lets the dashboard restore this exact screen on reload.
  useEffect(() => {
    reportLocation(window.location.pathname + window.location.search);
  }, [view]);

  // Confirmed subscribers across audiences, shown as the badge on "Audience".
  const subscribers = (status?.audiences ?? []).reduce((n, a) => n + (a.subscribed_count ?? 0), 0);
  const groups = [{ items: NAV.map(({ view: _v, ...n }) => (n.id === "audience" && subscribers ? { ...n, count: subscribers } : n)) }];

  if (loading) return <div className="flex h-full items-center justify-center text-muted-foreground">Loading…</div>;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <AppNav
        title="OpenNewsletter"
        icon="mail"
        groups={groups}
        active={editing === null ? view : undefined}
        onNavigate={(item) => navigate(NAV.find((n) => n.id === item.id)?.view ?? "mail")}
      />
      <main className="min-w-0 flex-1 overflow-auto">
        {editing !== null ? (
          <Editor mailId={editing} onBack={() => setEditing(null)} />
        ) : view === "mail" ? (
          <MailsView openMail={setEditing} />
        ) : view === "templates" ? (
          <TemplatesView openMail={setEditing} />
        ) : view === "audience" ? (
          <AudienceView />
        ) : (
          <SettingsView />
        )}
      </main>

      {error ? (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-destructive px-4 py-2 text-sm text-white shadow-lg">
          {error}
          <button className="ml-3 font-semibold opacity-80 hover:opacity-100" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}
