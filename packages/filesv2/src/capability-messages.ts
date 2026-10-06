import { i18n } from "@k2b/stdlib";

/** Runtime text of Files capabilities: approval reviews, summaries, and search metadata in the caller's locale. */
const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      storage: "Storage",
      path: "Path",
      size: "Size",
      targetStorage: "Target storage",
      targetFolder: "Target folder",
      newName: "New name",
      restoreTo: "Restore to",
      originalPlace: "Original place",
      topLevel: "Top level",
      createFile: ({ name }: { name: string }) => `Create the file “${name}”.`,
      replaceFile: ({ name }: { name: string }) => `Replace the file “${name}”. Its current content is overwritten.`,
      saveFile: ({ name }: { name: string }) => `Save the new file “${name}”.`,
      trashEntry: ({ name }: { name: string }) => `Move “${name}” to the trash.`,
      restoreEntry: "Restore an entry from the trash.",
      createFolder: ({ name }: { name: string }) => `Create the folder “${name}”.`,
      renameEntry: ({ name, newName }: { name: string; newName: string }) => `Rename “${name}” to “${newName}”.`,
      moveEntry: ({ name }: { name: string }) => `Move “${name}” to another folder.`,
      copyEntry: ({ name }: { name: string }) => `Copy “${name}”.`,
      movedToTrash: "Moved to trash",
      partialSearch: ({ searched, omitted, unavailable }: { searched: number; omitted: number; unavailable: number }) =>
        `Partial results: ${searched} storage bases searched, ${omitted} further and ${unavailable} unavailable bases. More entries may exist. Continue searching in Files.`,
    },
    de: {
      storage: "Ablage",
      path: "Pfad",
      size: "Größe",
      targetStorage: "Zielablage",
      targetFolder: "Zielordner",
      newName: "Neuer Name",
      restoreTo: "Wiederherstellen nach",
      originalPlace: "Ursprünglicher Ort",
      topLevel: "Oberste Ebene",
      createFile: ({ name }) => `Datei „${name}“ anlegen.`,
      replaceFile: ({ name }) => `Datei „${name}“ ersetzen. Der bisherige Inhalt wird überschrieben.`,
      saveFile: ({ name }) => `Neue Datei „${name}“ speichern.`,
      trashEntry: ({ name }) => `„${name}“ in den Papierkorb verschieben.`,
      restoreEntry: "Einen Eintrag aus dem Papierkorb wiederherstellen.",
      createFolder: ({ name }) => `Ordner „${name}“ erstellen.`,
      renameEntry: ({ name, newName }) => `„${name}“ in „${newName}“ umbenennen.`,
      moveEntry: ({ name }) => `„${name}“ in einen anderen Ordner verschieben.`,
      copyEntry: ({ name }) => `„${name}“ kopieren.`,
      movedToTrash: "In den Papierkorb verschoben",
      partialSearch: ({ searched, omitted, unavailable }) =>
        `Unvollständige Ergebnisse: ${searched} Ablagen geprüft, ${omitted} weitere und ${unavailable} nicht verfügbare Ablagen. Weitere Treffer können vorhanden sein. In Dateien weitersuchen.`,
    },
  },
});

export const filesCapabilityMessages = (locale: string) => messages.resolve([locale]).t;
