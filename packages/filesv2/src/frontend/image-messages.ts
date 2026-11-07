import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";

export const imageMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      edit: "Edit image",
      save: "Save",
      version: "Save new version",
      copy: "Save copy",
      edited: "edited",
      loading: "Loading image…",
      failed: "The image could not be loaded.",
      retry: "Try again",
      tooLarge: "Image editing supports files up to 50 MiB.",
      changed: "The file changed. Your edits are preserved. Save a copy instead.",
      saveFailed: "The image could not be saved. Your edits are preserved.",
      copyConflict: "That copy already exists. Save a copy again to use the next name.",
      uncertain: "The upload result is not yet known. Check this upload before saving anything else. Your edits are preserved.",
      check: "Check upload",
      saved: "Image saved",
      refreshFailed: "The image was saved, but the folder could not be refreshed.",
      discard: "Discard unsaved changes?",
    },
    de: {
      edit: "Bild bearbeiten",
      save: "Speichern",
      version: "Neue Version speichern",
      copy: "Kopie speichern",
      edited: "bearbeitet",
      loading: "Bild wird geladen…",
      failed: "Das Bild konnte nicht geladen werden.",
      retry: "Erneut versuchen",
      tooLarge: "Die Bildbearbeitung unterstützt Dateien bis 50 MiB.",
      changed: "Die Datei wurde inzwischen geändert. Deine Änderungen bleiben erhalten. Speichere eine Kopie.",
      saveFailed: "Das Bild konnte nicht gespeichert werden. Deine Änderungen bleiben erhalten.",
      copyConflict: "Diese Kopie gibt es bereits. Speichere erneut eine Kopie, um den nächsten Namen zu verwenden.",
      uncertain:
        "Das Ergebnis des Uploads ist noch offen. Prüfe diesen Upload, bevor du erneut speicherst. Deine Änderungen bleiben erhalten.",
      check: "Upload prüfen",
      saved: "Bild gespeichert",
      refreshFailed: "Das Bild wurde gespeichert, aber der Ordner konnte nicht neu geladen werden.",
      discard: "Ungespeicherte Änderungen verwerfen?",
    },
  },
});
export const useImageMessages = () => {
  const locale = useLocale();
  return () => imageMessages.resolve([locale()]).t;
};
