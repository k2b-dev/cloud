import type { CapabilityPresentationCatalog } from "@k2b/cloud/contracts";

export const pulseCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        base: {
          title: "Pulse Basis",
          description: "Ein Pulse-Telemetriearbeitsbereich mit Berechtigungsbereich.",
        },
        resource: {
          title: "Pulse-Ressource",
          description: "Eine beobachtete Ressource mit Metriken, Ereignissen oder Zuständen.",
        },
        saved_query: {
          title: "Pulse Gespeichert Query",
          description: "Eine benannte, validierte Pulse-Abfrage, die in einer Basis gespeichert ist.",
        },
        source: {
          title: "Pulse Quelle",
          description: "Eine Telemetriequelle und ihr aktueller Aufnahme- oder Scraping-Zustand.",
        },
      },
      queries: {
        "base.list": {
          title: "Liste der Pulse-Basen",
          description:
            "Normaler Eintrag für Basis-Telemetriearbeiten. Listen Sie zugängliche Pulse-Basen auf und verwenden Sie zurückgegebene pulse.base refs oder IDs mit Lesern, Quellen- und Signalerkennung oder Abfrageaufrufen.",
          input: {
            query: "Optionale Textsuche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "base.read": {
          title: "Die Pulse-Basis lesen",
          description: "Lesen Sie einen von base.list oder base.search zurückgegebenen pulse.base ref.",
          input: {
            id: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
          },
        },
        "base.search": {
          title: "Pulse-Basen suchen",
          description:
            "Suchen Sie eine zugängliche Pulse-Basis anhand des Namens oder der Beschreibung, wenn deren ID unbekannt ist. Verwenden Sie zurückgegebene pulse.base refs mit base.read oder deren IDs mit source.list, metric.search, field.search und Abfragetools.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            pulse: {
              title: "Pulse",
              description: "Nur Pulse-Sockel anzeigen.",
            },
          },
        },
        "field.search": {
          title: "Pulse-Felder durchsuchen",
          description:
            "Entdecken Sie Dimensions- oder Attributschlüssel für Metriken, Ereignisse und Zustände in einer bekannten Basis, ohne Werte offenzulegen. Verwenden Sie metric.search für Metriknamen, dann query.compile vor query.execute.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            query: "Optionale Textsuche.",
            scope: "Optionaler Signaltypfilter.",
            role: "Zu entdeckende Feldrolle; Sensible Felder sind ausgeschlossen.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "metric.search": {
          title: "Pulse-Metriken durchsuchen",
          description:
            "Entdecken Sie Metriknamen und -typen, bevor Sie eine Abfrage in einer bekannten Datenbank erstellen. BaseId von base.list oder base.search abrufen; Validieren Sie die resultierende DSL mit query.compile vor query.execute.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            query: "Optionale Textsuche.",
            type: "Optionaler Metriktypfilter.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "query.compile": {
          title: "Kompilieren Sie Pulse Query",
          description:
            "Validieren Sie die Pulse-Abfrage-DSL für eine Basis-ID von base.list oder base.search, ohne Telemetriezeilen zu lesen. Verwenden Sie metric.search und field.search, um gültige Namen zu ermitteln. Führen Sie gültiges DSL mit query.execute aus.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            query: "Pulse DSL-Text abfragen.",
          },
        },
        "query.execute": {
          title: "Telemetrieabfrage ausführen",
          description:
            "Führen Sie die Pulse-Abfrage-DSL für eine Basis-ID von base.list oder base.search aus, normalerweise nach query.compile. Gibt höchstens 500 Punkte oder 100 kompakte Zeilen zurück; Rohe Ereignisnutzdaten werden weggelassen und abgeschnittene Berichte enthalten keine Ergebnisse.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            query: "Pulse DSL-Text abfragen.",
          },
        },
        "resource.read": {
          title: "Die Pulse-Ressource lesen",
          description:
            "Lesen Sie eine beobachtete Pulse-Ressource, indem Sie das zusammengesetzte ID von einem unveränderten resource.search pulse.resource ref übergeben.",
          input: {
            id: "Zusammengesetzter Wert aus Basis-ID/Ressourcenschlüssel, zurückgegeben von Search Pulse Resources in a pulse.resource ref; Übergeben Sie die ref-ID unverändert.",
          },
        },
        "resource.search": {
          title: "Pulse-Ressourcen durchsuchen",
          description:
            "Direkter basenübergreifender Eintrag zum Auffinden beobachteter Ressourcen. Verwenden Sie das zurückgegebene zusammengesetzte Element pulse.resource ref unverändert mit resource.read. Verwenden Sie metric.search oder field.search, wenn Sie eine Abfrage in einer bekannten Basis erstellen.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            "pulse-resource": {
              title: "Pulse-Ressourcen",
              description: "Nur beobachtete Pulse-Ressourcen anzeigen.",
            },
          },
        },
        "saved_query.execute": {
          title: "Gespeicherte Telemetrieabfrage ausführen",
          description:
            "Führen Sie eine gespeicherte Abfrage mit „baseId“ und „queryId“ aus „saved_query.list“ aus. Dadurch wird query.compile übersprungen, da die gespeicherte DSL bereits validiert ist und das gleiche begrenzte Ergebnis wie query.execute zurückgibt.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            queryId:
              "Die gespeicherte Abfrage ID wurde von der Liste der gespeicherten Pulse Queries oder pulse.saved_query ref zurückgegeben.",
          },
        },
        "saved_query.list": {
          title: "Liste gespeichert Pulse Queries",
          description:
            "Listen Sie benannte Abfragen in einer bekannten Basis auf. BaseId von base.list oder base.search abrufen; Verwenden Sie das zurückgegebene pulse.saved_query refs mit „saved_query.read“ oder das zurückgegebene IDs mit „saved_query.execute“.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            query: "Optionale Textsuche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "saved_query.read": {
          title: "Gespeichertes Pulse Query lesen",
          description:
            "Lesen Sie einen von „saved_query.list“ zurückgegebenen pulse.saved_query ref, einschließlich seiner gespeicherten DSL und Basis-ID.",
          input: {
            id: "Die gespeicherte Abfrage ID wurde von der Liste der gespeicherten Pulse Queries oder pulse.saved_query ref zurückgegeben.",
          },
        },
        "source.list": {
          title: "Pulse-Quellen auflisten",
          description:
            "Listen Sie den Zustand der Quelle in einer bekannten Basis auf, ohne Anmeldeinformationen preiszugeben. BaseId von base.list oder base.search abrufen; Verwenden Sie das zurückgegebene pulse.source refs mit source.read.",
          input: {
            baseId: "Pulse Base ID zurückgegeben von Search/List Pulse Bases oder ein pulse.base ref.",
            query: "Optionale Textsuche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
        },
        "source.read": {
          title: "Die Pulse-Quelle lesen",
          description:
            "Lesen Sie einen von source.list zurückgegebenen pulse.source ref, einschließlich seines aktuellen Ingest- oder Scrape-Zustands.",
          input: {
            id: "Pulse Quelle ID, zurückgegeben von List Pulse Sources oder einem pulse.source ref.",
          },
        },
      },
      actions: {},
    },
  },
};
