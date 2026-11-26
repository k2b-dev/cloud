import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * The words only a v2 workspace says: its sidebar's collapse button and the notice of a part that did not load. They
 * stay out of the shared catalog, so an island that renders no workspace (a PWA part's count) never carries them.
 */
const workspaceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      hideSidebar: "Hide sidebar",
      controlsFailed: "This part of the page could not be loaded.",
      reloadPage: "Reload page",
    },
    de: {
      hideSidebar: "Seitenleiste ausblenden",
      controlsFailed: "Dieser Teil der Seite konnte nicht geladen werden.",
      reloadPage: "Seite neu laden",
    },
  },
});

export type WorkspaceMessages = ReturnType<(typeof workspaceMessages)["resolve"]>["t"];

export const useWorkspaceMessages = (): (() => WorkspaceMessages) => {
  const locale = useLocale();
  return () => workspaceMessages.resolve([locale()]).t;
};

/** The words in the page's language (`<html lang>`), for code that runs outside a component. */
export const resolveWorkspaceMessages = (): WorkspaceMessages =>
  workspaceMessages.resolve([typeof document === "undefined" ? workspaceMessages.baseLocale : document.documentElement.lang]).t;

export const checkWorkspaceMessages = () => workspaceMessages.check();
