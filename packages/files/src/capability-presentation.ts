import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

export const filesCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        directory: {
          title: "Verzeichnis",
          description: "Ein Ordner im persönlichen oder freigegebenen Speicher.",
        },
        file: {
          title: "Datei",
          description: "Eine Datei im persönlichen oder gemeinsam genutzten Speicher.",
        },
      },
      queries: {
        "directory.read": {
          title: "Verzeichnismetadaten lesen",
          description:
            "Lesen Sie begrenzte Metadaten und die untergeordnete Anzahl für ein bekanntes Verzeichnis, ohne dessen Inhalt zurückzugeben.",
          input: {
            id: "Genaue files.directory-Ressource ID aus dem von Suchdateien zurückgegebenen typed ref.",
          },
        },
        "file.read": {
          title: "Dateimetadaten lesen",
          description:
            "Liest begrenzte Metadaten für eine bekannte Datei aus ihrer typisierten Ressource ref. Dadurch wird kein Dateiinhalt zurückgegeben.",
          input: {
            id: "Genaue files.file-Ressource ID aus dem von Suchdateien zurückgegebenen typed ref.",
          },
        },
        search: {
          title: "Dateien durchsuchen",
          description: "Finden Sie nach Berechtigungen gefilterte Dateien und Verzeichnisse in allen zugänglichen Speicherbasen.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            file: {
              title: "Dateien",
              description: "Nur Dateien anzeigen.",
            },
            folder: {
              title: "Ordner",
              description: "Nur Verzeichnisse anzeigen.",
            },
            image: {
              title: "Bilder",
              description: "Nur Bilddateien anzeigen.",
            },
            excel: {
              title: "Tabellenkalkulationen",
              description: "Tabellenkalkulationsdateien wie XLSX, XLS und CSV anzeigen.",
            },
            pdf: {
              title: "PDF",
              description: "Nur PDF-Dokumente anzeigen.",
            },
          },
        },
      },
      actions: {},
    },
  },
};
