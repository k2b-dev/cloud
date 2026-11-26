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
      unread: ({ count, chats }: { count: string; chats: number }) =>
        chats === 1 ? `${count} unread in 1 chat` : `${count} unread in ${chats} chats`,
      unreadMore: ({ count }: { count: string }) => `${count}+ unread`,
      allRead: "All read",
      archived: ({ count }: { count: number }) => (count === 1 ? "1 archived chat" : `${count} archived chats`),
      forYouFact: "for you",
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
      unread: ({ count, chats }: { count: string; chats: number }) =>
        chats === 1 ? `${count} ungelesen in 1 Chat` : `${count} ungelesen in ${chats} Chats`,
      unreadMore: ({ count }: { count: string }) => `${count}+ ungelesen`,
      allRead: "Alles gelesen",
      archived: ({ count }: { count: number }) => (count === 1 ? "1 archivierter Chat" : `${count} archivierte Chats`),
      forYouFact: "für dich",
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
