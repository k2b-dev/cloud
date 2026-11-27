import { i18n } from "@k2b/stdlib";

/** The words of Chat's v2 frame that the v1 catalog does not have. Provisional with @k2b/ui v2. */
export const chatV2Messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sidebarWidth: "Width of the sidebar",
      listWidth: "Width of the chat list",
      chatPane: "Chat",
      infoPane: "Chat info",
      places: "Places",
      noneOpen: "No chat open",
      mentions: ({ count, names }: { count: string; names: string }) => `${count === "1" ? "1 mention" : `${count} mentions`} · ${names}`,
      directAndGroups: "People and groups",
      listActions: "Chat list actions",
      chatActions: "Chat actions",
      threads: "Threads",
      openThreads: "Show threads",
      info: "Info",
      closeInfo: "Close info",
      searchResults: "Search results",
      adminProviders: "Places that cannot notify",
    },
    de: {
      sidebarWidth: "Breite der Seitenleiste",
      listWidth: "Breite der Chatliste",
      chatPane: "Chat",
      infoPane: "Chatinfo",
      places: "Orte",
      noneOpen: "Kein Chat geöffnet",
      mentions: ({ count, names }: { count: string; names: string }) =>
        `${count === "1" ? "1 Erwähnung" : `${count} Erwähnungen`} · ${names}`,
      directAndGroups: "Personen und Gruppen",
      listActions: "Aktionen der Chatliste",
      chatActions: "Aktionen des Chats",
      threads: "Threads",
      openThreads: "Threads zeigen",
      info: "Info",
      closeInfo: "Info schließen",
      searchResults: "Suchergebnisse",
      adminProviders: "Orte ohne Benachrichtigung",
    },
  },
});
