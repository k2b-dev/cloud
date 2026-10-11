import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const fileBrowserMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      downloadAsZip: "Download as ZIP",
      rename: "Rename",
      addFileFolderUpload: "Add file, folder, or upload",
      files: "Files",
      chooseFileToPreview: "Choose a file to preview it.",
      discardChanges: "Discard changes",
      discardUnsavedFile: "Discard the unsaved changes in this file?",
      downloadFailed: "Download failed",
      folderEmpty: "This folder is empty.",
      folderSelected: "Folder selected",
      newFile: "New file",
      newFileName: "Name of the new file:",
      newFolder: "New folder",
      newFolderName: "Name of the new folder:",
      fileActions: "File actions",
      actionsFor: ({ name }: { name: string }) => `Actions for ${name}`,
      pickFileFromTree: "Pick a file from the tree to view it.",
      selectFile: "Select a file",
      spaceEmpty: "This space is empty.",
      uploadFiles: "Upload files",
      loadingFiles: "Loading files...",
      noFiles: "No files",
    },
    de: {
      downloadAsZip: "Als ZIP herunterladen",
      rename: "Umbenennen",
      addFileFolderUpload: "Datei oder Ordner hinzufügen oder hochladen",
      files: "Dateien",
      chooseFileToPreview: "Wähle eine Datei für die Vorschau aus.",
      discardChanges: "Änderungen verwerfen",
      discardUnsavedFile: "Ungespeicherte Änderungen an dieser Datei verwerfen?",
      downloadFailed: "Download fehlgeschlagen",
      folderEmpty: "Dieser Ordner ist leer.",
      folderSelected: "Ordner ausgewählt",
      newFile: "Neue Datei",
      newFileName: "Name der neuen Datei:",
      newFolder: "Neuer Ordner",
      newFolderName: "Name des neuen Ordners:",
      fileActions: "Dateiaktionen",
      actionsFor: ({ name }) => `Aktionen für ${name}`,
      pickFileFromTree: "Wähle im Dateibaum eine Datei aus.",
      selectFile: "Datei auswählen",
      spaceEmpty: "Dieser Bereich ist leer.",
      uploadFiles: "Dateien hochladen",
      loadingFiles: "Dateien werden geladen...",
      noFiles: "Keine Dateien",
    },
  },
});

export type FileBrowserMessages = ReturnType<(typeof fileBrowserMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useFileBrowserMessages = (): (() => FileBrowserMessages) => {
  const locale = useLocale();
  return () => fileBrowserMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolveFileBrowserMessages = (locale?: string): FileBrowserMessages =>
  fileBrowserMessages.resolve([
    locale ?? (typeof document === "undefined" ? fileBrowserMessages.baseLocale : document.documentElement.lang),
  ]).t;

export const checkFileBrowserMessages = () => fileBrowserMessages.check();
