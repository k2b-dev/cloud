import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const workspaceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      rowAction: "Row action",
      sidebarUnread: ({ count }: { count: number }) => `${count} unread`,
      sidebarUnreadMany: "more than 99 unread",
      sidebarNewActivity: "new activity",
      sidebarMentioned: "mentions you",
      sidebarMuted: "muted",
      resizeNavigation: "Resize navigation",
      resizeWorkspacePane: "Resize workspace pane",
      resizeDetailPanel: "Resize detail panel",
      details: "Details",
      detailFullHeight: "Full height",
      resizeBottomDrawer: "Resize bottom drawer",
      showNavigation: "Show navigation",
      backTo: ({ page }: { page: string }) => `Back to ${page}`,
      path: "Path",
      moreLevels: "More levels",
    },
    de: {
      rowAction: "Zeilenaktion",
      sidebarUnread: ({ count }) => `${count} ungelesen`,
      sidebarUnreadMany: "mehr als 99 ungelesen",
      sidebarNewActivity: "neue Aktivität",
      sidebarMentioned: "erwähnt dich",
      sidebarMuted: "stummgeschaltet",
      resizeNavigation: "Breite der Navigation ändern",
      resizeWorkspacePane: "Breite des Arbeitsbereichs ändern",
      resizeDetailPanel: "Breite des Detailbereichs ändern",
      details: "Details",
      detailFullHeight: "Volle Höhe",
      resizeBottomDrawer: "Höhe des unteren Bereichs ändern",
      showNavigation: "Navigation anzeigen",
      backTo: ({ page }) => `Zurück zu ${page}`,
      path: "Pfad",
      moreLevels: "Weitere Ebenen",
    },
  },
});

export type WorkspaceMessages = ReturnType<(typeof workspaceMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useWorkspaceMessages = (): (() => WorkspaceMessages) => {
  const locale = useLocale();
  return () => workspaceMessages.resolve([locale()]).t;
};

export const checkWorkspaceMessages = () => workspaceMessages.check();
