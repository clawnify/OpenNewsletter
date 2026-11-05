import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { useHostChanges } from "@clawnify/app/client";
import { api } from "./api";
import type { Mail, Template, Settings, StatusInfo } from "../shared/types";

interface Store {
  loading: boolean;
  error: string | null;
  setError: (e: string | null) => void;

  status: StatusInfo | null;
  settings: Settings | null;
  templates: Template[];
  mails: Mail[];

  refreshStatus: () => Promise<void>;
  refreshMails: () => Promise<void>;
  refreshTemplates: () => Promise<void>;
  saveSettings: (s: Partial<Settings>) => Promise<void>;

  createMail: (templateSlug?: string) => Promise<Mail>;
  saveMail: (id: number, patch: Partial<Mail>) => Promise<Mail>;
  deleteMail: (id: number) => Promise<void>;
}

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mails, setMails] = useState<Mail[]>([]);

  const refreshStatus = useCallback(async () => setStatus(await api<StatusInfo>("GET", "/api/status")), []);
  const refreshMails = useCallback(async () => setMails(await api<Mail[]>("GET", "/api/mails")), []);
  const refreshTemplates = useCallback(async () => setTemplates(await api<Template[]>("GET", "/api/templates")), []);

  const saveSettings = useCallback(async (s: Partial<Settings>) => {
    setSettings(await api<Settings>("PUT", "/api/settings", s));
  }, []);

  const createMail = useCallback(async (templateSlug?: string) => {
    const mail = await api<Mail>("POST", "/api/mails", { template_slug: templateSlug });
    setMails((prev) => [mail, ...prev]);
    return mail;
  }, []);

  const saveMail = useCallback(async (id: number, patch: Partial<Mail>) => {
    const mail = await api<Mail>("PUT", `/api/mails/${id}`, patch);
    setMails((prev) => prev.map((i) => (i.id === id ? mail : i)));
    return mail;
  }, []);

  const deleteMail = useCallback(async (id: number) => {
    await api("DELETE", `/api/mails/${id}`);
    setMails((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      // Load each section independently so one failing endpoint degrades
      // gracefully (shows its real error) instead of blanking the whole app.
      const results = await Promise.allSettled([
        api<StatusInfo>("GET", "/api/status").then(setStatus),
        api<Settings>("GET", "/api/settings").then(setSettings),
        api<Template[]>("GET", "/api/templates").then(setTemplates),
        api<Mail[]>("GET", "/api/mails").then(setMails),
      ]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) setError((failed.reason as Error).message);
      setLoading(false);
    })();
  }, []);

  // The Clawnify chat just wrote through the API: reload what the lists show.
  useHostChanges(() => {
    void Promise.allSettled([refreshMails(), refreshTemplates(), refreshStatus(), api<Settings>("GET", "/api/settings").then(setSettings)]);
  });

  const value: Store = {
    loading, error, setError, status, settings, templates, mails,
    refreshStatus, refreshMails, refreshTemplates, saveSettings, createMail, saveMail, deleteMail,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
