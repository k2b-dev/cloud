import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unknownOriginal: "Original location unknown",
      unknownDate: "Deletion time unknown",
      restorePath: "Restore to path",
      restoreHint: "Enter the full destination path within this storage, including the name. Existing files are never replaced.",
      unresolved:
        "This move has not been confirmed. Refresh to check its result. If it stays unresolved, ask an administrator to inspect the operation.",
      retry: "Refresh",
    },
    de: {
      unknownOriginal: "Ursprünglicher Speicherort unbekannt",
      unknownDate: "Löschzeitpunkt unbekannt",
      restorePath: "Zielpfad für die Wiederherstellung",
      restoreHint:
        "Gib den vollständigen Zielpfad innerhalb dieser Ablage einschließlich des Namens an. Vorhandene Dateien werden niemals ersetzt.",
      unresolved:
        "Dieser Verschiebevorgang ist noch nicht bestätigt. Aktualisiere, um sein Ergebnis zu prüfen. Bleibt er ungeklärt, kann die Administration den Vorgang untersuchen.",
      retry: "Aktualisieren",
    },
  },
});
export const useTrashMessages = () => {
  const locale = useLocale();
  return () => messages.resolve([locale()]).t;
};
