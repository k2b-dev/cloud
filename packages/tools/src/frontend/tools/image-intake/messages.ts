import { i18n } from "@k2b/stdlib";
import { HEIF_MAX_BYTES, HEIF_MAX_PIXELS } from "./formats";

const megapixels = HEIF_MAX_PIXELS / 1_000_000;
const mebibytes = HEIF_MAX_BYTES / (1024 * 1024);
export const imageIntakeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      unsupportedTitle: "This format is not supported.",
      unsupportedHint: "Convert it to JPEG, PNG, WebP, or HEIC first. Or choose another file.",
      "too-largeTitle": "This photo is too large to convert here.",
      "too-largeHint": `HEIC photos up to ${megapixels} MP and ${mebibytes} MiB work. Make the photo smaller first, or choose another file.`,
      "decode-failedTitle": "This image could not be read.",
      "decode-failedHint": "The file may be damaged. Export it again from the source app, or choose another file.",
      "decoder-unavailableTitle": "The HEIC decoder could not be loaded.",
      "decoder-unavailableHint": "Reload the page and try again. Or convert the photo to JPEG first.",
      waiting: "Waiting",
      "loading-decoder": "Loading the HEIC decoder",
      decoding: "Converting",
      loadingFile: ({ stage, name, index, count }: { stage: string; name: string; index: number; count: number }) =>
        `${stage} ${name} (${index} of ${count})`,
      failuresLabel: "Files that could not be added",
      dismissFailures: "Dismiss file errors",
    },
    de: {
      unsupportedTitle: "Dieses Format wird nicht unterstützt.",
      unsupportedHint: "Wandle die Datei zuerst in JPEG, PNG, WebP oder HEIC um. Oder wähle eine andere Datei.",
      "too-largeTitle": "Dieses Foto ist zu groß für die Konvertierung hier.",
      "too-largeHint": `HEIC-Fotos bis ${megapixels} MP und ${mebibytes} MiB funktionieren. Verkleinere das Foto zuerst oder wähle eine andere Datei.`,
      "decode-failedTitle": "Dieses Bild konnte nicht gelesen werden.",
      "decode-failedHint":
        "Die Datei ist möglicherweise beschädigt. Exportiere sie erneut aus der ursprünglichen App oder wähle eine andere Datei.",
      "decoder-unavailableTitle": "Der HEIC-Decoder konnte nicht geladen werden.",
      "decoder-unavailableHint": "Lade die Seite neu und versuche es noch einmal. Oder wandle das Foto zuerst in JPEG um.",
      waiting: "Wartet",
      "loading-decoder": "HEIC-Decoder wird geladen",
      decoding: "Wird konvertiert",
      loadingFile: ({ stage, name, index, count }) => `${stage}: ${name} (${index} von ${count})`,
      failuresLabel: "Nicht hinzugefügte Dateien",
      dismissFailures: "Dateifehler ausblenden",
    },
  },
});
