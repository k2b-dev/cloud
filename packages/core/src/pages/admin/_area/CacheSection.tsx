import { coreClient } from "@k2b/cloud/clients/core";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Section, useToast } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { adminToasts } from "./toasts";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      settings: "Settings cache",
      announcements: "Announcement cache",
      settingsHint:
        "Settings are cached for five minutes across applications. Saving invalidates changed values automatically. Clear the cache here if applications show outdated settings. Sessions and access checks remain unchanged.",
      announcementsHint:
        "Announcements are cached for five minutes across applications. Saving and deleting invalidate this cache automatically. Scheduled publication and expiry are checked on every page request. Already open pages need to be reloaded.",
      clear: "Clear cache",
    },
    de: {
      settings: "Einstellungen-Cache",
      announcements: "Ankündigungen-Cache",
      settingsHint:
        "Einstellungen werden anwendungsübergreifend für fünf Minuten zwischengespeichert. Speichern setzt geänderte Werte automatisch zurück. Wenn Anwendungen veraltete Einstellungen zeigen, kannst du den Cache hier leeren. Sitzungen und Zugriffsprüfungen bleiben unverändert.",
      announcementsHint:
        "Ankündigungen werden anwendungsübergreifend für fünf Minuten zwischengespeichert. Speichern und Löschen setzen den Cache automatisch zurück. Geplante Veröffentlichung und Ablauf werden bei jedem Seitenaufruf geprüft. Bereits geöffnete Seiten müssen neu geladen werden.",
      clear: "Cache leeren",
    },
  },
});

export const checkCacheSectionMessages = () => messages.check();

/** What the shared cache of settings or announcements does, and the deed that clears it; the toast reports the outcome. */
export default function CacheSection(props: { area: "settings" | "announcements" }) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const n = () => adminToasts.resolve([locale()]).t;
  const toast = useToast();
  const [busy, setBusy] = createSignal(false);
  const clear = async () => {
    setBusy(true);
    try {
      const client = coreClient.admin.core;
      const response = props.area === "settings" ? await client.settings.cache.$delete({}) : await client.announcements.cache.$delete({});
      toast(response.ok ? n().cacheCleared : n().cacheNotCleared, { status: response.ok ? "ok" : "bad" });
    } catch {
      toast(n().cacheNotCleared, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      icon="database-cog"
      title={t()[props.area]}
      summary={props.area === "settings" ? t().settingsHint : t().announcementsHint}
      actions={[{ label: t().clear, icon: "eraser", onClick: () => void clear(), disabled: busy() }]}
    />
  );
}
