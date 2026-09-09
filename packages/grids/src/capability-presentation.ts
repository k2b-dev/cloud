import type { CapabilityPresentationCatalog } from "@valentinkolb/cloud/contracts";

export const gridsCapabilityPresentation: CapabilityPresentationCatalog = {
  baseLocale: "en",
  translations: {
    de: {
      types: {
        document: { title: "Grids-Dokument", description: "Ein gespeichertes unveränderliches Dokument mit Artefakt-Metadaten." },
        "workflow-run": { title: "Grids-Workflow-Lauf", description: "Status einer angenommenen Workflow-Ausführung." },
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
        "document.templates": {
          title: "Dokumentvorlagen finden",
          description:
            "Vorlagen einer Tabelle aus gql.context finden. Aktivierte Vorlagen mit document.create verwenden oder gespeicherte Dokumente mit document.list lesen.",
        },
        "document.list": {
          title: "Gespeicherte Dokumente finden",
          description:
            "Eine begrenzte Dokumentseite einer Vorlage aus document.templates lesen. Dokumentreferenzen mit document.read öffnen; es wird kein neues Dokument erzeugt.",
        },
        "document.read": {
          title: "Gespeichertes Dokument lesen",
          description:
            "Metadaten und Prüfsummen einer Dokumentreferenz lesen. Der authentifizierte Download liefert gespeicherte PDF-Bytes, keine neue Darstellung.",
        },
        "workflow.record-actions": {
          title: "Record-Aktionen finden",
          description:
            "Ausführbare Record-Aktionen einer Basis aus base.list finden. Auch bei leeren gefilterten Seiten nextOffset folgen. Tabelle und Revision anschließend mit workflow.record-action verwenden.",
        },
        "workflow.run.read": {
          title: "Workflow-Status lesen",
          description:
            "Status einer Laufreferenz aus workflow.record-action lesen. Benötigt Lesezugriff auf die Basis; interne Eingaben, Ergebnisse und Ereignisse werden nicht ausgegeben.",
        },
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
          title: "Grids-Abfragekontext laden",
          description:
            "Lade das relevante Schema für eine konkrete Aufgabe. Bei unbekannter Quelle zuerst tables, sonst fields mit tableId. options benötigt tableId und fieldId. Unbenutzte IDs weglassen, keine leeren Strings senden. includeWriteContext nur vor Datensatzänderungen verwenden.",
          input: {
            baseId: "Öffentliche Basis ID, deren berechtigungsbasierter GQL-Kontext geladen werden soll.",
            kind: "Katalogabschnitt: Tabellen, Ansichten, Felder oder genaue Auswahloption IDs.",
            tableId: "Öffentlicher Tisch ID; Erforderlich für Felder und Optionen, optional für Ansichten.",
            fieldId: "Öffentliches Auswahlfeld ID; erforderlich, wenn Art Optionen ist.",
            includeWriteContext:
              "Nur bei fields: Schreibrechte, Pflichtfelder und Audit-Anforderungen vor einer Datensatzänderung mitladen. Für Abfragen weglassen.",
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
        "view.create": {
          title: "Abfrage als Grids-Ansicht speichern",
          description:
            "Eine geprüfte GQL-Abfrage als persönliche oder geteilte Ansicht speichern. Erfordert Base-Adminrechte und Bestätigung. Ändert keine Tabellen oder Datensätze. Bei ungewissem Ergebnis zuerst vorhandene Ansichten prüfen, nicht blind wiederholen.",
        },
        "document.create": {
          title: "Unveränderliches Dokument ausstellen",
          description:
            "Ein Dokument aus einer Vorlage und einem Record ausstellen. Eine vergebene Nummer bleibt dauerhaft. Jede Ausstellung einzeln bestätigen; denselben Idempotenzschlüssel nur für Wiederholungen desselben Auftrags verwenden. Keine Konformitätsgarantie oder externe Zustellung.",
        },
        "workflow.record-action": {
          title: "Record-Workflow ausführen",
          description:
            "Mit der gefundenen Revision einen verknüpften Korrektur- oder Storno-Entwurf zu einem abgeschlossenen Original anlegen. Das Original bleibt unverändert; keine Ausstellung oder Zustellung. Immer ausdrücklich bestätigen; keine beliebigen Workflow-Quellen oder zusätzlichen Eingaben.",
        },
        "record.create": {
          title: "Einen Grids-Datensatz erstellen",
          description:
            "Lade zuerst gql.context mit kind fields und includeWriteContext true. Erstelle dann einen Datensatz mit öffentlichen IDs beschreibbarer Felder als Schlüssel. Auswahlwerte verwenden Options-IDs. Gibt begrenzte Metadaten zurück; Feldwerte mit gezieltem GQL lesen. Nicht idempotent: nicht blind wiederholen.",
          input: {
            tableId: "Öffentliches ID der beschreibbaren gespeicherten Tabelle, die den Datensatz empfangen soll.",
            values: "Öffentliches Feld IDs, das explizit bereitgestellten Werten zugeordnet ist.",
          },
        },
        "record.update": {
          title: "Den Grids-Eintrag aktualisieren",
          description:
            "Lade gql.context mit kind fields und includeWriteContext true für Wert- und Audit-Anforderungen, danach record.read für ifVersion. Nur übergebene Felder werden geändert; veraltete Versionen werden abgelehnt. Gibt begrenzte Metadaten zurück; Feldwerte mit gezieltem GQL lesen.",
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
            "Lade zuerst gql.context mit kind fields und includeWriteContext true. Ordne provider + providerAccount + resourceKind + externalId wiederholungssicher einem Datensatz zu. Der erste Aufruf erstellt ihn; spätere Änderungen benötigen ifVersion und ändern nur übergebene Felder.",
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
