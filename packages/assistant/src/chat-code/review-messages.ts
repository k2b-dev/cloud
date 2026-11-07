import { i18n } from "@k2b/stdlib";

/**
 * What a person approves for Studio code tools and for requests from managed code, in the reader's language. Each
 * review is plain text: a first sentence with the consequence, then "Label: value" lines the approval card shows as
 * rows. Identifiers, paths, and keys stay verbatim.
 */
export const reviewMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      chat: "Chat",
      project: "Project",
      app: "App",
      appRef: ({ title, id }: { title: string; id: string }) => `App “${title}” (${id})`,
      place: ({ scope, title, id }: { scope: string; title: string; id: string }) => `${scope} “${title}” (${id})`,
      source: "Source",
      target: "Target",
      size: "Size",
      copyFile: ({ path }: { path: string }) => `Copy “${path}”.`,
      createFile: "Create a new file.",
      replaceFile: "Replace the reviewed destination file.",
      sharedFiles: "Files in Apps and Projects can be read by other authorized users. No other files are transferred.",
      deleteApp: ({ app }: { app: string }) => `Permanently delete ${app}. This cannot be undone.`,
      deletedWithApp: "Also deleted",
      deletedParts: ({ files, keys }: { files: number; keys: number }) =>
        `All source history, publications and access grants, ${files} shared files, ${keys} JSON keys`,
      database: "Database",
      connectedDatabase: "Connected; it is deleted afterwards",
      noDatabase: "Not connected",
      clearDatabase: ({ app }: { app: string }) =>
        `Permanently delete all records in the database of ${app}. Tables and their structure stay intact.`,
      resetDatabase: ({ app }: { app: string }) =>
        `Permanently discard the entire database of ${app}, including all tables and data. The next connection starts empty.`,
      databasePreserved: "Source, publications, files and JSON storage are preserved.",
      clearPartial: "If this fails, some tables may already be empty.",
      files: "Shared files",
      kv: "JSON keys",
      all: "All storage",
      deleteKey: ({ key, area, app }: { key: string; area: string; app: string }) => `Permanently delete “${key}” from ${area} of ${app}.`,
      clearArea: ({ area, app }: { area: string; app: string }) => `Permanently delete all entries from ${area} of ${app}.`,
      areaInSentence: ({ area }: { area: "files" | "kv" | "all" }): string =>
        area === "files" ? "the shared files" : area === "kv" ? "the JSON storage" : "all storage",
      currentStorage: "Current storage",
      storageEntry: ({ area, items, size }: { area: string; items: number; size: string }) => `${area} ${items} (${size})`,
      emptyStorage: "Empty",
      storagePreserved: "Source, publications and database are preserved.",
      changeAccess: ({ app }: { app: string }) => `Change access to ${app}.`,
      recipient: "Recipient",
      before: "Before",
      after: "After",
      noAccess: "No access",
      removeAccess: "Remove access",
      skillsUnchanged: "This does not change access to any Skill.",
      publicAccess:
        "Public access runs only the published App, without database, server files or KV, secrets, or protected Cloud actions. Public Manage access is not possible.",
      unpublish: ({ app, version }: { app: string; version: number }) => `Withdraw publication ${version} of ${app}.`,
      unpublishEffect: "People with Use access can no longer start its interface or actions. Source, history and data remain.",
      importFiles: ({ app }: { app: string }) => `Import the reviewed files into the source of ${app}.`,
      importEffect:
        "Existing source paths in this batch are replaced. Imported data becomes App source and may be shared or published with it.",
      appResource: "App",
      secret: ({ name }: { name: string }) => `secret “${name}”`,
      body: ({ size }: { size: string }) => `Body (${size})`,
    },
    de: {
      chat: "Chat",
      project: "Projekt",
      app: "App",
      appRef: ({ title, id }) => `App „${title}“ (${id})`,
      place: ({ scope, title, id }) => `${scope} „${title}“ (${id})`,
      source: "Quelle",
      target: "Ziel",
      size: "Größe",
      copyFile: ({ path }) => `„${path}“ kopieren.`,
      createFile: "Es wird eine neue Datei angelegt.",
      replaceFile: "Die geprüfte Zieldatei wird ersetzt.",
      sharedFiles: "Dateien in Apps und Projekten können andere Berechtigte lesen. Andere Dateien werden nicht übertragen.",
      deleteApp: ({ app }) => `${app} endgültig löschen. Das kann nicht rückgängig gemacht werden.`,
      deletedWithApp: "Ebenfalls gelöscht",
      deletedParts: ({ files, keys }) =>
        `Gesamter Quellcodeverlauf, alle Veröffentlichungen und Zugriffsrechte, ${files} gemeinsame Dateien, ${keys} JSON-Schlüssel`,
      database: "Datenbank",
      connectedDatabase: "Verbunden; sie wird anschließend gelöscht",
      noDatabase: "Nicht verbunden",
      clearDatabase: ({ app }) =>
        `Alle Datensätze in der Datenbank von ${app} endgültig löschen. Tabellen und ihre Struktur bleiben erhalten.`,
      resetDatabase: ({ app }) =>
        `Die gesamte Datenbank von ${app} mit allen Tabellen und Daten endgültig verwerfen. Die nächste Verbindung beginnt leer.`,
      databasePreserved: "Quellcode, Veröffentlichungen, Dateien und JSON-Speicher bleiben erhalten.",
      clearPartial: "Schlägt das fehl, können einige Tabellen bereits leer sein.",
      files: "Gemeinsame Dateien",
      kv: "JSON-Schlüssel",
      all: "Gesamter Speicher",
      deleteKey: ({ key, area, app }) => `„${key}“ endgültig aus ${area} von ${app} löschen.`,
      clearArea: ({ area, app }) => `Alle Einträge aus ${area} von ${app} endgültig löschen.`,
      areaInSentence: ({ area }) =>
        area === "files" ? "den gemeinsamen Dateien" : area === "kv" ? "dem JSON-Speicher" : "dem gesamten Speicher",
      currentStorage: "Aktueller Speicher",
      storageEntry: ({ area, items, size }) => `${area} ${items} (${size})`,
      emptyStorage: "Leer",
      storagePreserved: "Quellcode, Veröffentlichungen und Datenbank bleiben erhalten.",
      changeAccess: ({ app }) => `Zugriff auf ${app} ändern.`,
      recipient: "Empfänger",
      before: "Vorher",
      after: "Nachher",
      noAccess: "Kein Zugriff",
      removeAccess: "Zugriff entfernen",
      skillsUnchanged: "Der Zugriff auf Skills bleibt unverändert.",
      publicAccess:
        "Öffentlicher Zugriff startet nur die veröffentlichte App, ohne Datenbank, Serverdateien oder KV, Secrets oder geschützte Cloud-Aktionen. Öffentliches Verwalten ist nicht möglich.",
      unpublish: ({ app, version }) => `Veröffentlichung ${version} von ${app} zurückziehen.`,
      unpublishEffect:
        "Personen mit Nutzungszugriff können ihre Oberfläche und Aktionen nicht mehr starten. Quellcode, Verlauf und Daten bleiben erhalten.",
      importFiles: ({ app }) => `Die geprüften Dateien in den Quellcode von ${app} importieren.`,
      importEffect:
        "Vorhandene Quellpfade in diesem Stapel werden ersetzt. Importierte Daten werden Quellcode der App und können mit ihr geteilt oder veröffentlicht werden.",
      appResource: "App",
      secret: ({ name }) => `Secret „${name}“`,
      body: ({ size }) => `Inhalt (${size})`,
    },
  },
});
