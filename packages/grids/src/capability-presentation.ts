import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const gridsCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        base: {
          title: "Grids Basis",
          description: "Ein Grids-Arbeitsbereich mit Berechtigungsbereich.",
        },
        record: {
          title: "Grids-Datensatz",
          description: "Ein stabiler Datensatz in einer Grids-Tabelle.",
        },
        table: {
          title: "Grids Tisch",
          description: "Eine lesbare gespeicherte oder kombinierte Tabelle in einer Basis.",
        },
        view: {
          title: "Grids Ansicht",
          description: "Eine gespeicherte GQL-Datenansicht mit Berechtigungsbereich.",
        },
      },
      queries: {
        "base.list": {
          title: "Liste der Grids-Basen",
          description:
            "Normaler Eintrag für Grids-Arbeiten mit Basisbereich. Listen Sie zugängliche Basen auf und verwenden Sie zurückgegebenes grids.base refs oder IDs mit base.read, gql.context, gql.preview, gql.execute oder gql.view.execute.",
          input: {
            query: "Optionaler Basisname, Beschreibung oder Kurz-ID-Suche.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Artikel.",
          },
        },
        "base.read": {
          title: "Die Grids-Basis lesen",
          description: "Lesen Sie einen von base.list oder base.search zurückgegebenen grids.base ref.",
          input: {
            id: "Stabile öffentliche Basis ID.",
          },
        },
        "base.search": {
          title: "Grids-Basen suchen",
          description:
            "Suchen Sie eine zugängliche Grids-Basis anhand des Namens, der Beschreibung oder der Kurzform ID, wenn der ID unbekannt ist. Verwenden Sie zurückgegebene grids.base refs mit base.read oder deren IDs mit gql.context- und GQL-Abfragen.",
          input: {
            query: "Vom Benutzer eingegebener Suchtext. Leerer Text ist zulässig, wenn eine Facette die Abfrage einschränkt.",
            tags: "Von dieser Abfrage unterstützte kanonische Suchfacetten.",
            limit: "Maximale Anzahl der zurückzugebenden Ergebnisse.",
          },
          searchTags: {
            grid: {
              title: "Grids",
              description: "Nur Grids-Sockel anzeigen.",
            },
          },
        },
        "gql.context": {
          title: "Laden Sie den Grids GQL-Kontext",
          description:
            "Laden Sie das Schema, bevor Sie GQL erstellen oder Schreibvorgänge aufzeichnen. BaseId von base.list oder base.search abrufen; Zuerst Tabellen anfordern, dann Felder oder Auswahloptionen mit zurückgegebenem IDs oder Ansichten für gql.view.execute. Feldergebnisse umfassen Schreib- und Prüfanforderungen.",
          input: {
            baseId: "Öffentliche Basis ID, deren berechtigungsbasierter GQL-Kontext geladen werden soll.",
            kind: "Katalogabschnitt: Tabellen, Ansichten, Felder oder genaue Auswahloption IDs.",
            tableId: "Öffentlicher Tisch ID; Erforderlich für Felder und Optionen, optional für Ansichten.",
            fieldId: "Öffentliches Auswahlfeld ID; erforderlich, wenn Art Optionen ist.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            limit: "Maximale Anzahl der zurückzugebenden Artikel.",
          },
        },
        "gql.execute": {
          title: "Grids GQL ausführen",
          description:
            "Führen Sie das erlaubnissichere GQL nach gql.context und normalerweise nach gql.preview aus. Wählen Sie nur benötigte Felder aus; zurückgegebenes grids.record refs kann mit record.read geöffnet werden, und nextCursor setzt bytebegrenzte Seiten fort.",
          input: {
            baseId: "Öffentliche Basis ID, in der die GQL-Quelle aufgelöst ist.",
            query: "Grids Query Auszuführende Sprachquelle.",
            currentTableId: "Optionale öffentliche Tabelle ID, die verwendet wird, wenn die Quelle eine explizite from-Klausel weglässt.",
            currentSource: "Optionale aktuelle Tabellen- oder Ansichtsquelle, die verwendet wird, wenn GQL weglässt.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            pageSize: "Maximale Anzahl an Zeilen, die auf dieser Cursorseite zurückgegeben werden sollen.",
            limit: "Optionale logische Ergebnisobergrenze über Cursorseiten hinweg.",
          },
        },
        "gql.preview": {
          title: "Vorschau Grids GQL",
          description:
            "Validieren Sie das berechtigungssichere GQL, nachdem IDs mit gql.context geladen wurde. Gibt eine kleine Probe oder umsetzbare Diagnose ohne Mutation zurück; Übergeben Sie gültiges GQL unverändert an gql.execute.",
          input: {
            baseId: "Öffentliche Basis ID, in der die GQL-Quelle aufgelöst ist.",
            query: "Grids Query Auszuführende Sprachquelle.",
            currentTableId: "Optionale öffentliche Tabelle ID, die verwendet wird, wenn die Quelle eine explizite from-Klausel weglässt.",
            currentSource: "Optionale aktuelle Tabellen- oder Ansichtsquelle, die verwendet wird, wenn GQL weglässt.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
            pageSize: "Maximale Anzahl zurückzugebender Vorschauzeilen.",
          },
        },
        "gql.view.execute": {
          title: "Gespeicherte Grids-Ansicht ausführen",
          description:
            "Führen Sie die genaue gespeicherte Abfrage für eine Basis-ID und eine Ansichts-ID aus, die von gql.context-Typansichten zurückgegeben werden. Dies ist der direkte Pfad zur gespeicherten Ansicht. Verwenden Sie gql.execute für Ad-hoc-GQL und nextCursor für weitere Seiten.",
          input: {
            baseId: "Öffentliche Basis ID, die die gespeicherte Ansicht enthält.",
            viewId: "Öffentliche gespeicherte Ansicht ID, deren genau gespeicherter GQL ausgeführt werden soll.",
            pageSize: "Maximale Anzahl an Zeilen, die auf dieser Cursorseite zurückgegeben werden sollen.",
            cursor: "Undurchsichtiger Cursor, der von der vorherigen Seite zurückgegeben wurde.",
          },
        },
        "record.read": {
          title: "Den Grids-Datensatz lesen",
          description:
            "Lesen Sie einen von gql.execute, gql.preview oder einem Datensatz Action zurückgegebenen grids.record ref. Gibt Metadaten, den Finalisierungsstatus und die aktuelle Version für record.update zurück; Verwenden Sie gezielt gql.execute, um Feldwerte zu lesen.",
          input: {
            id: "Stabile öffentliche Live-Aufnahme ID.",
          },
        },
        "table.read": {
          title: "Die Tabelle Grids lesen",
          description:
            "Lesen Sie eine von gql.context-Typtabellen zurückgegebene grids.table ref, einschließlich des Basiskontexts und der effektiven Berechtigung.",
          input: {
            id: "Stabiler öffentlicher Tisch ID.",
          },
        },
        "view.read": {
          title: "Die Grids-Ansicht lesen",
          description:
            "Lesen Sie einen von gql.context zurückgegebenen grids.view ref-Typ. Führen Sie es mit gql.view.execute und derselben Basis-ID aus.",
          input: {
            id: "Stabile öffentliche Ansicht ID.",
          },
        },
      },
      actions: {
        "record.create": {
          title: "Einen Grids-Datensatz erstellen",
          description:
            "Rufen Sie zuerst die Artfelder gql.context auf und erstellen Sie dann einmal mit Werten, die durch das öffentliche beschreibbare Feld ID verschlüsselt sind. Wählen Sie Werte mit der Option IDs aus. Gibt begrenzte Metadaten zurück; Werte mit gezieltem GQL lesen. Diese Aktion ist nicht idempotent.",
          input: {
            tableId: "Öffentliches ID der beschreibbaren gespeicherten Tabelle, die den Datensatz empfangen soll.",
            values: "Öffentliches Feld IDs, das explizit bereitgestellten Werten zugeordnet ist.",
          },
        },
        "record.update": {
          title: "Den Grids-Eintrag aktualisieren",
          description:
            "Laden Sie Felder für Wert- und Prüfanforderungen und dann record.read für ifVersion. Nur vor Ort erhältlicher öffentlicher IDs-Wechsel; veraltete Versionen werden abgelehnt. Gibt begrenzte Metadaten zurück; Werte mit gezieltem GQL lesen.",
          input: {
            tableId: "Öffentliches ID der beschreibbaren gespeicherten Tabelle, die den Datensatz enthält.",
            recordId: "Stabile öffentliche Live-Aufnahme ID zum Aktualisieren.",
            values: "Öffentliches Feld IDs, das explizit bereitgestellten Ersatzwerten zugeordnet ist.",
            ifVersion: "Von record.read zurückgegebene Datensatzversion; veraltete Versionen werden abgelehnt.",
            audit: "Antworten, die für die Tabellenüberwachungsrichtlinie erforderlich sind, sofern sie konfiguriert ist.",
            "audit.answers": "Prüffrage UUIDs ihren Antworten zugeordnet.",
          },
        },
        "record.upsert-external": {
          title: "Externen Grids-Datensatz hochladen",
          description:
            "Binden Sie Provider + ProviderAccount + ResourceKind + ExternalId erneut sicher an einen Datensatz. Die erste Anfrage erstellt es; Spätere Updates erfordern nur ifVersion und den bereitgestellten Patch Field IDs.",
          input: {
            tableId: "Öffentliches ID der beschreibbaren gespeicherten Tabelle, die den Datensatz besitzt.",
            externalRef: "Groß- und Kleinschreibung beachtete dauerhafte Identität des Quelldatensatzes außerhalb von Grids.",
            "externalRef.provider": "Externer System- oder Connectorname.",
            "externalRef.providerAccount": "Stabiles Anbieterkonto oder Mieteridentität.",
            "externalRef.resourceKind": "Art der externen Ressource.",
            "externalRef.externalId": "Stabile ID innerhalb des externen Systems.",
            values: "Öffentliches Feld IDs, das explizit bereitgestellten Werten zugeordnet ist.",
            ifVersion: "Erforderliche aktuelle Datensatzversion, wenn die externe Identität bereits vorhanden ist.",
            audit: "Antworten, die von der Tabellenüberwachungsrichtlinie für eine vorhandene Datensatzaktualisierung gefordert werden.",
            "audit.answers": "Prüffrage UUIDs ihren Antworten zugeordnet.",
          },
        },
      },
    },
  },
};
