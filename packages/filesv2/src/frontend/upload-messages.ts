import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import type { UploadAnnouncement, UploadStatus } from "./upload-batch";

const enFiles = (n: number) => (n === 1 ? "1 file" : `${n} files`);
const deFiles = (n: number) => (n === 1 ? "1 Datei" : `${n} Dateien`);
const enAllExist = (n: number) => (n === 1 ? "The file already exists" : `All ${n} files already exist`);
const deAllExist = (n: number) => (n === 1 ? "Die Datei existiert bereits" : `Alle ${n} Dateien existieren bereits`);

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      percent: (value: number) => `${value}%`,
      uploadingTo: (target: string) => `Uploading to “${target}”`,
      uploading: "Uploading",
      uploadedTo: (target: string) => `Uploaded to “${target}”`,
      uploaded: "Upload complete",
      nothingUploaded: "Nothing uploaded",
      allExist: enAllExist,
      failedTitle: (n: number) => `${enFiles(n)} failed`,
      cancelled: "Upload cancelled",
      count: ({ done, count }: { done: number; count: number }) => `${done} of ${enFiles(count)}`,
      errors: (n: number) => (n === 1 ? "1 error" : `${n} errors`),
      valueText: ({ percent, done, count }: { percent: number; done: number; count: number }) =>
        `${percent}%, ${done} of ${enFiles(count)} uploaded`,
      bar: "Total upload progress",
      list: "Files in this upload",
      showList: "Show file list",
      hideList: "Hide file list",
      dismiss: "Dismiss notification",
      cancel: "Cancel",
      cancelUpload: "Cancel upload",
      retry: "Try again",
      retryAll: (n: number) => `Upload ${enFiles(n)} again`,
      retryFile: (name: string) => `Try again: ${name}`,
      retryHint: "Try again uploads the file once more.",
      status: (status: UploadStatus) =>
        ({
          pending: "Waiting",
          working: "Uploading",
          success: "Uploaded",
          failed: "Failed",
          skipped: "Skipped, already exists",
          cancelled: "Cancelled",
        })[status],
      failed: "Could not be uploaded",
      offline: "No connection",
      announce: (said: UploadAnnouncement | { kind: "failures"; count: number }): string => {
        switch (said.kind) {
          case "started":
            return `Upload started: ${enFiles(said.count)}.`;
          case "appended":
            return `${enFiles(said.added)} added. Now ${enFiles(said.count)} in the upload.`;
          case "progress":
            return `${said.percent}% uploaded, ${said.done} of ${enFiles(said.count)}.`;
          case "failed":
            return `${said.name} could not be uploaded: ${said.reason}.`;
          case "failures":
            return `${enFiles(said.count)} could not be uploaded.`;
          case "retrying":
            return said.count === 1 ? `Uploading ${said.name} again.` : `Uploading ${enFiles(said.count)} again.`;
          case "finished":
            if (said.failed) return `Upload finished. ${said.done} of ${enFiles(said.count)} uploaded, ${said.failed} failed.`;
            return !said.count && said.skipped
              ? `Nothing uploaded. ${enAllExist(said.skipped)}.`
              : `Upload complete. ${enFiles(said.done)} uploaded${said.skipped ? `, ${said.skipped} skipped because they already exist` : ""}.`;
          case "cancelled":
            return `Upload cancelled. ${said.done} of ${enFiles(said.count)} uploaded.`;
        }
      },
    },
    de: {
      percent: (value: number) => `${value} %`,
      uploadingTo: (target: string) => `Hochladen nach „${target}“`,
      uploading: "Hochladen",
      uploadedTo: (target: string) => `In „${target}“ hochgeladen`,
      uploaded: "Upload abgeschlossen",
      nothingUploaded: "Nichts hochgeladen",
      allExist: deAllExist,
      failedTitle: (n: number) => `${deFiles(n)} fehlgeschlagen`,
      cancelled: "Upload abgebrochen",
      count: ({ done, count }: { done: number; count: number }) => `${done} von ${deFiles(count)}`,
      errors: (n: number) => `${n} Fehler`,
      valueText: ({ percent, done, count }: { percent: number; done: number; count: number }) =>
        `${percent} %, ${done} von ${deFiles(count)} hochgeladen`,
      bar: "Fortschritt des gesamten Uploads",
      list: "Dateien in diesem Upload",
      showList: "Dateiliste anzeigen",
      hideList: "Dateiliste ausblenden",
      dismiss: "Benachrichtigung schließen",
      cancel: "Abbrechen",
      cancelUpload: "Upload abbrechen",
      retry: "Erneut versuchen",
      retryAll: (n: number) => `${deFiles(n)} erneut hochladen`,
      retryFile: (name: string) => `Erneut versuchen: ${name}`,
      retryHint: "Erneut versuchen lädt die Datei noch einmal hoch.",
      status: (status: UploadStatus) =>
        ({
          pending: "Wartet",
          working: "Wird hochgeladen",
          success: "Hochgeladen",
          failed: "Fehlgeschlagen",
          skipped: "Übersprungen, existiert bereits",
          cancelled: "Abgebrochen",
        })[status],
      failed: "Konnte nicht hochgeladen werden",
      offline: "Keine Verbindung",
      announce: (said: UploadAnnouncement | { kind: "failures"; count: number }): string => {
        switch (said.kind) {
          case "started":
            return `Upload gestartet: ${deFiles(said.count)}.`;
          case "appended":
            return `${deFiles(said.added)} hinzugefügt. Jetzt ${deFiles(said.count)} im Upload.`;
          case "progress":
            return `${said.percent} % hochgeladen, ${said.done} von ${deFiles(said.count)}.`;
          case "failed":
            return `${said.name} konnte nicht hochgeladen werden: ${said.reason}.`;
          case "failures":
            return `${deFiles(said.count)} konnten nicht hochgeladen werden.`;
          case "retrying":
            return said.count === 1 ? `${said.name} wird erneut hochgeladen.` : `${deFiles(said.count)} werden erneut hochgeladen.`;
          case "finished":
            if (said.failed) return `Upload beendet. ${said.done} von ${deFiles(said.count)} hochgeladen, ${said.failed} fehlgeschlagen.`;
            return !said.count && said.skipped
              ? `Nichts hochgeladen. ${deAllExist(said.skipped)}.`
              : `Upload abgeschlossen. ${deFiles(said.done)} hochgeladen${said.skipped ? `, ${said.skipped} übersprungen, weil sie bereits existieren` : ""}.`;
          case "cancelled":
            return `Upload abgebrochen. ${said.done} von ${deFiles(said.count)} hochgeladen.`;
        }
      },
    },
  },
});

export const useUploadMessages = () => {
  const locale = useLocale();
  return () => messages.resolve([locale()]).t;
};
