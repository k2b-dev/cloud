import { coreClient } from "@k2b/cloud/clients/core";
import { i18n } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, NoticeCard, toast, useLocale } from "@k2b/ui";
import { onCleanup, Show } from "solid-js";

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
      clearing: "Clearing cache…",
      cleared: "Cache invalidated. Data will reload on the next request.",
      error: "Could not invalidate the cache. Try again.",
    },
    de: {
      settings: "Einstellungen-Cache",
      announcements: "Ankündigungen-Cache",
      settingsHint:
        "Einstellungen werden anwendungsübergreifend für fünf Minuten zwischengespeichert. Speichern setzt geänderte Werte automatisch zurück. Wenn Anwendungen veraltete Einstellungen zeigen, kannst du den Cache hier leeren. Sitzungen und Zugriffsprüfungen bleiben unverändert.",
      announcementsHint:
        "Ankündigungen werden anwendungsübergreifend für fünf Minuten zwischengespeichert. Speichern und Löschen setzen den Cache automatisch zurück. Geplante Veröffentlichung und Ablauf werden bei jedem Seitenaufruf geprüft. Bereits geöffnete Seiten müssen neu geladen werden.",
      clear: "Cache leeren",
      clearing: "Cache wird geleert…",
      cleared: "Cache zurückgesetzt. Die Daten werden beim nächsten Aufruf neu geladen.",
      error: "Der Cache konnte nicht zurückgesetzt werden. Versuche es erneut.",
    },
  },
});

export default function CacheNotice(props: { area: "settings" | "announcements" }) {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const clear = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const client = coreClient.admin.core;
      const response =
        props.area === "settings"
          ? await client.settings.cache.$delete({}, { init: { signal: abortSignal } })
          : await client.announcements.cache.$delete({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().error);
    },
    onSuccess: () => toast.success(t().cleared),
  });
  onCleanup(() => clear.abort());
  return (
    <div class="space-y-3">
      <NoticeCard title={t()[props.area]}>
        <div class="space-y-3">
          <p>{props.area === "settings" ? t().settingsHint : t().announcementsHint}</p>
          <Button variant="secondary" loading={clear.loading()} loadingLabel={t().clearing} onClick={() => void clear.mutate()}>
            {t().clear}
          </Button>
        </div>
      </NoticeCard>
      <Show when={clear.error()}>{(error) => <NoticeCard tone="danger">{error().message}</NoticeCard>}</Show>
    </div>
  );
}
