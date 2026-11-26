import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

/**
 * The words of dragging entries onto places in v2 (Table, Tiles and Nav). They live apart from the shared catalog so a
 * part that imports only a small component never carries them.
 */
const dragMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      entries: ({ count }: { count: number }) => `${count.toLocaleString("en")} entries`,
      dropNothing: "Drop here: nothing happens",
      dropFoldersRefused: "Folders can't be dropped here, only files",
    },
    de: {
      entries: ({ count }) => `${count.toLocaleString("de")} Einträge`,
      dropNothing: "Hier loslassen: nichts passiert",
      dropFoldersRefused: "Ordner können hier nicht abgelegt werden, nur Dateien",
    },
  },
});

export type DragMessages = ReturnType<(typeof dragMessages)["resolve"]>["t"];

export const useDragMessages = (): (() => DragMessages) => {
  const locale = useLocale();
  return () => dragMessages.resolve([locale()]).t;
};

export const checkDragMessages = () => dragMessages.check();
