import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const codeDiffMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      codeDiffLabel: "Code difference, read only",
      codeDiffFiles: "Files",
      codeDiffUnchangedLines: ({ count }: { count: string }) => `${count} unchanged lines`,
      codeDiffUnchangedLine: "1 unchanged line",
      codeDiffAdded: ({ line }: { line: number }) => `Added, line ${line}:`,
      codeDiffRemoved: ({ line }: { line: number }) => `Removed, line ${line}:`,
      codeDiffMarked: "Marked line.",
      codeDiffSame: "unchanged",
      codeDiffLines: ({ count }: { count: string }) => `${count} lines`,
      codeDiffNewFile: ({ path }: { path: string }) => `${path}, new file`,
      codeDiffMore: ({ count }: { count: string }) => `Show ${count} more lines`,
      codeDiffMoreOne: "Show 1 more line",
      codeDiffLoading: "Loading the code",
      codeDiffError: "The code could not be loaded",
      codeDiffEmpty: "The code is unchanged",
      codeDiffSameNoted: "This file is unchanged. The commented lines follow.",
    },
    de: {
      codeDiffLabel: "Code-Unterschied, nur lesen",
      codeDiffFiles: "Dateien",
      codeDiffUnchangedLines: ({ count }) => `${count} unveränderte Zeilen`,
      codeDiffUnchangedLine: "1 unveränderte Zeile",
      codeDiffAdded: ({ line }) => `Hinzugefügt, Zeile ${line}:`,
      codeDiffRemoved: ({ line }) => `Entfernt, Zeile ${line}:`,
      codeDiffMarked: "Markierte Zeile.",
      codeDiffSame: "gleich",
      codeDiffLines: ({ count }) => `${count} Zeilen`,
      codeDiffNewFile: ({ path }) => `${path}, neue Datei`,
      codeDiffMore: ({ count }) => `${count} weitere Zeilen anzeigen`,
      codeDiffMoreOne: "1 weitere Zeile anzeigen",
      codeDiffLoading: "Code wird geladen",
      codeDiffError: "Der Code konnte nicht geladen werden",
      codeDiffEmpty: "Der Code ist unverändert",
      codeDiffSameNoted: "Diese Datei ist unverändert. Unten stehen die kommentierten Zeilen.",
    },
  },
});

export type CodeDiffMessages = ReturnType<(typeof codeDiffMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useCodeDiffMessages = (): (() => CodeDiffMessages) => {
  const locale = useLocale();
  return () => codeDiffMessages.resolve([locale()]).t;
};

export const checkCodeDiffMessages = () => codeDiffMessages.check();
