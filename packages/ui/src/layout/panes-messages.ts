import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const panesMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      addPane: "Add pane",
      addToNamed: ({ name }: { name: string }) => `Add to ${name}`,
      insertBeforeNamed: ({ name }: { name: string }) => `Insert before ${name}`,
      insertAtEnd: "Insert at end",
      addPaneSide: ({ side, name }: { side: "left" | "right" | "top" | "bottom"; name: string }) => `Add ${side} of ${name}`,
      paneTabs: "Pane tabs",
      paneWorkspace: "Pane workspace",
      resizePanes: "Resize panes",
    },
    de: {
      addPane: "Bereich hinzufügen",
      addToNamed: ({ name }) => `Zu ${name} hinzufügen`,
      insertBeforeNamed: ({ name }) => `Vor ${name} einfügen`,
      insertAtEnd: "Am Ende einfügen",
      addPaneSide: ({ side, name }) =>
        `${side === "left" ? "Links" : side === "right" ? "Rechts" : side === "top" ? "Oberhalb" : "Unterhalb"} von ${name} hinzufügen`,
      paneTabs: "Bereichs-Tabs",
      paneWorkspace: "Arbeitsbereich",
      resizePanes: "Bereiche skalieren",
    },
  },
});

export type PanesMessages = ReturnType<(typeof panesMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const usePanesMessages = (): (() => PanesMessages) => {
  const locale = useLocale();
  return () => panesMessages.resolve([locale()]).t;
};

export const checkPanesMessages = () => panesMessages.check();
