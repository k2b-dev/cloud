import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const floatingWindowMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      closeWindow: "Close window",
      minimizeWindow: "Minimize",
      maximizeWindow: "Maximize",
      restoreSize: "Restore size",
      restoreWindow: ({ title }: { title: string }) => `Restore ${title}`,
      moveWindow: ({ title }: { title: string }) => `Move ${title} window. Use arrow keys; hold Shift for larger steps.`,
      resizeWindow: "Resize window. Use arrow keys; hold Shift for larger steps.",
    },
    de: {
      closeWindow: "Fenster schließen",
      minimizeWindow: "Minimieren",
      maximizeWindow: "Vergrößern",
      restoreSize: "Verkleinern",
      restoreWindow: ({ title }) => `${title} wiederherstellen`,
      moveWindow: ({ title }) => `Fenster ${title} verschieben. Pfeiltasten verwenden; Umschalt für größere Schritte halten.`,
      resizeWindow: "Fenster skalieren. Pfeiltasten verwenden; Umschalt für größere Schritte halten.",
    },
  },
});

export type FloatingWindowMessages = ReturnType<(typeof floatingWindowMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFloatingWindowMessages = (): (() => FloatingWindowMessages) => {
  const locale = useLocale();
  return () => floatingWindowMessages.resolve([locale()]).t;
};

export const checkFloatingWindowMessages = () => floatingWindowMessages.check();
