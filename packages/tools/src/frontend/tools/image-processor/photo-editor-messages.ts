import { i18n } from "@k2b/stdlib";
export const photoEditorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      photo: "Photo",
      open: "Choose photos to edit",
      intakeHint: "Drop images here, choose files, or paste a screenshot. HEIC and HEIF conversion is available.",
      local: "The images stay on your device.",
      add: "Add photos",
      download: "Download",
      downloadAll: "Download all as ZIP",
      dropToAdd: "Drop to add photos",
      retry: "Try again",
      loadFailed: "The photos could not be added. Try again.",
      pickerFailed: "The image picker could not be opened. Try again.",
      exportFailed: "The archive could not be created. Your edits are still here. Open the photo with the error and try again.",
    },
    de: {
      photo: "Foto",
      open: "Fotos zum Bearbeiten wählen",
      intakeHint: "Lege Bilder ab, wähle Dateien oder füge einen Screenshot ein. HEIC und HEIF können umgewandelt werden.",
      local: "Die Bilder bleiben auf deinem Gerät.",
      add: "Fotos hinzufügen",
      download: "Herunterladen",
      downloadAll: "Alle als ZIP herunterladen",
      dropToAdd: "Fotos zum Hinzufügen ablegen",
      retry: "Erneut versuchen",
      loadFailed: "Die Fotos konnten nicht hinzugefügt werden. Versuche es erneut.",
      pickerFailed: "Die Bildauswahl konnte nicht geöffnet werden. Versuche es erneut.",
      exportFailed:
        "Das Archiv konnte nicht erstellt werden. Deine Änderungen bleiben erhalten. Öffne das Foto mit dem Fehler und versuche es erneut.",
    },
  },
});
