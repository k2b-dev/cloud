import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

type Side = "left" | "right" | "top" | "bottom";
type Preset = "two" | "three" | "stacked" | "tabs";

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
      resizeHint: ({ direction }: { direction: "horizontal" | "vertical" }) =>
        `${direction === "horizontal" ? "Drag the width · ← →" : "Drag the height · ↑ ↓"} with the keyboard · Double-click: reset`,
      noPane: "No pane is open.",
      arrange: "Arrange",
      arrangement: "Arrangement",
      preset: ({ preset }: { preset: Preset }): string =>
        preset === "two" ? "Two" : preset === "three" ? "Three" : preset === "stacked" ? "Stacked" : "Tabs",
      moveNamed: ({ name }: { name: string }) => `Move “${name}”`,
      moveBeside: ({ side, name }: { side: Side; name: string }) =>
        side === "top"
          ? `Above “${name}”`
          : side === "bottom"
            ? `Below “${name}”`
            : side === "left"
              ? `Left of “${name}”`
              : `Right of “${name}”`,
      moveIntoGroup: ({ name }: { name: string }) => `As a tab with “${name}”`,
      moveTabPrevious: "Tab to the left",
      moveTabNext: "Tab to the right",
      ctrlKey: "Ctrl",
      resetArrangement: "Reset arrangement",
      arrangeNote: "The same menu opens with a right click on any tab.",
      arrangeHint: "Panes can be arranged",
      arrangeHintDetail: "Drag a tab by its grip beside another pane, or choose Arrange.",
      moved: ({ name, place }: { name: string; place: string }) => `Moved “${name}”: ${place}.`,
      arranged: ({ preset }: { preset: string }) => `Arranged: ${preset}.`,
      pickedUp: ({ name }: { name: string }) => `Picked up ${name}.`,
      dragOver: ({ name, place }: { name: string; place: string }) => `Move ${name} to ${place}.`,
      notOverPane: ({ name }: { name: string }) => `${name} is not over a pane.`,
      dropped: ({ name, place }: { name: string; place: string }) => `Moved ${name} to ${place}.`,
      notMoved: ({ name }: { name: string }) => `Did not move ${name}.`,
      cancelled: ({ name }: { name: string }) => `Cancelled moving ${name}.`,
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
      resizeHint: ({ direction }) =>
        `${direction === "horizontal" ? "Breite ziehen · ← →" : "Höhe ziehen · ↑ ↓"} mit der Tastatur · Doppelklick: zurück`,
      noPane: "Kein Bereich ist offen.",
      arrange: "Anordnen",
      arrangement: "Anordnung",
      preset: ({ preset }) => (preset === "two" ? "Zwei" : preset === "three" ? "Drei" : preset === "stacked" ? "Gestapelt" : "Tabs"),
      moveNamed: ({ name }) => `„${name}“ verschieben`,
      moveBeside: ({ side, name }) =>
        side === "top"
          ? `Über „${name}“`
          : side === "bottom"
            ? `Unter „${name}“`
            : side === "left"
              ? `Links neben „${name}“`
              : `Rechts neben „${name}“`,
      moveIntoGroup: ({ name }) => `Als Tab zu „${name}“`,
      moveTabPrevious: "Tab nach links",
      moveTabNext: "Tab nach rechts",
      ctrlKey: "Strg",
      resetArrangement: "Anordnung zurücksetzen",
      arrangeNote: "Dasselbe Menü öffnet ein Rechtsklick auf jeden Tab.",
      arrangeHint: "Bereiche lassen sich anordnen",
      arrangeHintDetail: "Zieh einen Tab am Griff neben einen anderen Bereich, oder wähle „Anordnen“.",
      moved: ({ name, place }) => `„${name}“ verschoben: ${place}.`,
      arranged: ({ preset }) => `Angeordnet: ${preset}.`,
      pickedUp: ({ name }) => `${name} aufgenommen.`,
      dragOver: ({ name, place }) => `${name}: ${place}.`,
      notOverPane: ({ name }) => `${name} ist über keinem Bereich.`,
      dropped: ({ name, place }) => `${name} verschoben: ${place}.`,
      notMoved: ({ name }) => `${name} nicht verschoben.`,
      cancelled: ({ name }) => `Verschieben von ${name} abgebrochen.`,
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
