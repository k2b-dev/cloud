import { i18n } from "@k2b/stdlib";

/** The words of Chat's v2 frame that the v1 catalog does not have. Provisional with @k2b/ui v2. */
export const chatV2Messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sidebarWidth: "Width of the sidebar",
      infoPane: "Chat info",
      noneOpen: "No chat open",
      moreDiscussions: "Show more discussions",
      chatActions: "Chat actions",
      threads: "Threads",
      info: "Info",
      closeInfo: "Close info",
      searchResults: "Search results",
      adminProviders: "Places that cannot notify",
      discussionState: "State",
      recentActivity: "Recent activity",
    },
    de: {
      sidebarWidth: "Breite der Seitenleiste",
      infoPane: "Chatinfo",
      noneOpen: "Kein Chat geöffnet",
      moreDiscussions: "Weitere Diskussionen anzeigen",
      chatActions: "Aktionen des Chats",
      threads: "Threads",
      info: "Info",
      closeInfo: "Info schließen",
      searchResults: "Suchergebnisse",
      adminProviders: "Orte ohne Benachrichtigung",
      discussionState: "Stand",
      recentActivity: "Zuletzt aktiv",
    },
  },
});
