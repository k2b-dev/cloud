---
id: grids-combined-tables
title: Kombinierte Tabellen
icon: ti ti-table-share
description: Veröffentliche eine zentral geregelte, schreibgeschützte Tabelle aus mehreren Basen.
order: 122
---
Eine kombinierte Tabelle stellt Datensätze aus mehreren gespeicherten Tabellen als eine zentral geregelte, schreibgeschützte Tabelle dar. Sie eignet sich, wenn Teams weiterhin in getrennten Basen arbeiten sollen, aber ein anderer Personenkreis einen einheitlichen Datenbestand für Audit, Berichte, Suche, Grids Apps, Dokumente, Workflows oder Exporte benötigt.

Regionale Teams können beispielsweise verschiedene Basen für ihre Bestände verwenden, während eine Audit-Basis eine Tabelle **Gesamtbestand** veröffentlicht. Personen mit Lesezugriff fragen die kanonischen Felder Name, Status und Standort ab, auch wenn die Quelltabellen andere Namen oder Select-Optionen verwenden.

Nutze keine kombinierte Tabelle, um lediglich eine Teilmenge einer einzelnen Tabelle darzustellen. Dafür ist eine Ansicht vorgesehen. Nutze sie auch nicht, wenn Personen die Quelldatensätze über die kombinierte Oberfläche bearbeiten müssen, denn die Veröffentlichung ist bewusst schreibgeschützt.

## Was eine kombinierte Tabelle verändert {icon="table"}

Die Zielbasis besitzt die kombinierte Tabelle, ihre kanonischen Felder und ihre Ansichten. Personen mit Administratorrechten für die Quellen autorisieren ausdrücklich ausgewählte Quelltabellen und Feldzuordnungen. Personen mit Lesezugriff auf die Zielbasis oder auf eine Grids App, die das kombinierte Ergebnis enthält, benötigen keinen Zugriff auf die Quellbasen. Suche, Filter, Sortierung, Seitennavigation, Gruppierung, Aggregation, Grids Apps und Exporte funktionieren über alle veröffentlichten Quellen hinweg wie bei einer gespeicherten Tabelle.

:::reference
- **Kanonische Felder:** Erstelle die Felder, die Personen sehen sollen, und ordne anschließend jedes Quellfeld dem passenden kanonischen Feld zu. Fehlende Zuordnungen geben für diese Quelle null zurück.
- **Unabhängige Veröffentlichung:** Personen mit Zugriff auf das Ziel erhalten nur kanonische Daten. Sie erhalten weder die Navigation der Quelle noch verborgene Quellfelder oder Bearbeitungsrechte.
- **Schreibgeschütztes Ergebnis:** Verwende die Tabelle in GQL, gespeicherten Ansichten, Grids Apps, Dokumenten, Workflows und Exporten. Das Erstellen von Datensätzen sowie Formulare, Importe, Uploads, Bearbeitungen und Löschungen sind nicht verfügbar.
- **Geschlossene Veröffentlichung bei Fehlern:** Eine widerrufene, gelöschte oder inkompatible Quelle macht die gesamte veröffentlichte Revision unverfügbar. Grids liefert nie stillschweigend ein kleineres Teilergebnis.
:::

## Erstellen und veröffentlichen {icon="square-plus"}

:::steps
1. **Erstelle die kombinierte Tabelle:** Wähle **Neue Tabelle**, dann **Kombinierte Tabelle**, und füge die kanonischen Felder hinzu, die später abgefragt werden sollen.
2. **Wähle Quellen:** Öffne im Bearbeitungsmodus den Bereich **Kombinierte Daten**. Die Auswahl listet nur gespeicherte Tabellen auf, deren Basis du verwalten darfst.
3. **Ordne Felder und Select-Optionen zu:** Ordne stabile Quellfelder anhand ihrer Identität zu. Select-Felder erfordern außerdem eine ausdrückliche Zuordnung für jede Quelloption.
4. **Validiere und veröffentliche:** Die Validierung meldet unvollständige oder inkompatible Zuordnungen, ohne die aktive Veröffentlichung zu ändern. Veröffentliche erst, nachdem alle Diagnosen behoben sind.
5. **Nutze die veröffentlichte Tabelle:** Gewähre Zugriff auf die Zielbasis oder nimm das Ergebnis in eine Grids App auf. Personen mit Administratorrechten für die Quelle können den exakt veröffentlichten Feldumfang prüfen und unabhängig widerrufen.
:::

:::note Autorisierung der Veröffentlichung
Das Veröffentlichen erfordert immer Administratorzugriff auf die Zielbasis. Administratorzugriff auf die Quellbasis ist nur für neuen oder erweiterten Quellumfang sowie für die Wiederherstellung nach einem Widerruf erforderlich. Bestehende, nicht widerrufene Zuordnungen können ohne erneute Autorisierung beibehalten, eingeschränkt oder entfernt werden. Eine veröffentlichte Freigabe bleibt gültig, wenn die autorisierende Person später ihre Rolle verliert. Eine Person mit Administratorrechten für die Quellbasis kann sie ausdrücklich widerrufen.
:::

## Abfragen und nachgelagertes Verhalten {icon="search"}

GQL verwendet keine besondere Syntax für kombinierte Tabellen. Die Autovervollständigung zeigt nur die kanonischen Zielfelder. Dieselbe Abfrage kann eine Datensatzseite, gespeicherte Ansicht, einen Grids-App-Block, eine Dokumentquelle, einen Workflow-Lesevorgang oder einen Streaming-Export versorgen.

**Unternehmensweiter Bestand**

```gql
from table "All inventory"
where Status = 'Available'
search 'camera'
sort Name asc
```

:::reference
- **Relationen:** Eine kanonische Relation muss auf ein gemeinsames gespeichertes Ziel oder auf ein anderes ausdrücklich veröffentlichtes kombiniertes Ziel mit den verknüpften Datensätzen verweisen.
- **Dateien:** Personen mit Lesezugriff auf die Zielbasis und kompilierte Grids-App-Capabilities können zugeordnete Dateien innerhalb der Veröffentlichungsgrenze der kombinierten Tabelle ansehen und herunterladen. Dateimetadaten und Änderungen an Dateien in der Quelle bleiben privat.
- **Berechnete Daten:** Kanonische Formeln können die kombinierten Felder verwenden. Ein berechnetes Quellfeld kann nur zugeordnet werden, wenn sein Ergebnis mit dem kanonischen Feld kompatibel ist.
- **Live-Daten und Exporte:** Änderungen an der Quelle erscheinen automatisch. CSV- und JSON-Exporte können über alle passenden Datensätze fortgesetzt werden.
:::

## Diagnosen und Reparatur {icon="lifebuoy"}

Diagnosen für den Entwurf nennen die betroffene Quelle, das kanonische Feld und das Quellfeld. Eine veröffentlichte Tabelle zeigt **Handlungsbedarf**, wenn ihre Felder oder der Zugriff auf eine Quelle nicht mehr gültig sind. Repariere die Quelle oder Zuordnungen, validiere den Entwurf und veröffentliche eine vollständige neue Revision. Widerrufener Zugriff wird erst durch eine neu autorisierte Veröffentlichung wiederhergestellt.

:::reference
- **Keine automatische Zuordnung:** Bezeichnungen, Positionen und ähnliche Feldtypen werden nie geraten. Jede veröffentlichte Zuordnung ist beabsichtigt.
- **Keine verschachtelten kombinierten Quellen:** Eine kombinierte Tabelle kann nur gespeicherte Tabellen als Quelle verwenden. Nutze eine kanonische Relation, wenn verknüpfte Datensätze ebenfalls zusammengeführt werden müssen.
- **Keine Änderungen an der Quelle:** Eine kombinierte Tabelle kann ihre Quelldatensätze nicht bearbeiten. Workflows dürfen kombinierte Daten lesen, aber das kombinierte Ziel nicht ändern.
- **Ausdrückliche Grenzen:** Eine kombinierte Tabelle unterstützt bis zu 50 Quelltabellen und 200 kanonische Felder.
:::

## Gelöschte Datensätze und Verlauf {icon="history"}

Kombinierte Tabellen erhalten den Lebenszyklus veröffentlichter Datensätze, ohne Zugriff auf deren Quellbasen zu gewähren. Personen mit Lesezugriff auf die Zielbasis können **Gelöschte anzeigen** wählen, um Datensätze zu prüfen, die in einer Quelltabelle gelöscht wurden. Ihre Detailansicht ist schreibgeschützt und nennt die veröffentlichte Quelle anhand des Namens der Basis und Tabelle. Stelle den ursprünglichen Datensatz in seiner Quellbasis wieder her oder bearbeite ihn dort.

Die Detailansicht des Datensatzes zeigt seinen veröffentlichten Verlauf. Personen mit Lesezugriff auf die Zielbasis können außerdem **Aktionen → Auditverlauf** wählen, um den Verlauf über alle veröffentlichten Datensätze hinweg zu durchsuchen und zu filtern. Personen mit Zugriff über eine Grids App erhalten nur den Verlauf, der ausdrücklich im veröffentlichten Capability-Snapshot enthalten ist.

:::reference
- **Aktuelle Veröffentlichung:** Der Verlauf wird durch die aktiven kanonischen Zuordnungen projiziert. Aus der Veröffentlichung entfernte Felder erscheinen nicht mehr, auch nicht in älteren Ereignissen.
- **Lebenszyklusereignisse:** Ereignisse für Erstellung, Änderung, Import, Löschung und Wiederherstellung bleiben sichtbar, solange ihre Quelle aktiv veröffentlicht ist.
- **Erforderliche Erklärungen:** Von einer Audit-Richtlinie erfasste Antworten, etwa ein erforderlicher Löschgrund, bleiben zusammen mit den Bezeichnungen ihrer Fragen am Ereignis erhalten.
- **Private Quelldetails:** Nicht veröffentlichte Felder und Werte, technische Anfragedetails und die Navigation der Quellbasis werden über die kombinierte Tabelle nicht offengelegt.
- **Geänderte Select-Optionen:** Eine alte Quelloption ohne aktive kanonische Zuordnung erscheint als nicht verfügbar, statt ihre Quellkennung offenzulegen.
- **Geschlossen bei Fehlern:** Widerrufene, beeinträchtigte oder inkompatible Veröffentlichungen liefern keinen Teilverlauf. Repariere die kombinierte Tabelle und veröffentliche sie erneut, bevor du fortfährst.
:::

## Lebenszyklus über die CLI {icon="code"}

Die CLI akzeptiert exakte Namen oder 6-stellige öffentliche IDs. Der Zuordnungsinhalt verwendet JSON statt einer eigenen Konfigurationssprache. Nutze `cld grids tables combined candidates`, um autorisierbare Quellen zu finden, und validiere die Konfiguration vor dem Speichern oder Veröffentlichen.

**Erstellen, prüfen, veröffentlichen und widerrufen**

```text
cld grids tables create Reporting --name "All inventory" --kind federated --json
cld grids fields create Reporting "All inventory" --name Name --type text --json
cld grids tables combined candidates Reporting "All inventory" --json
cld grids tables combined validate Reporting "All inventory" --body-file combined.json --json
cld grids tables combined draft Reporting "All inventory" --body-file combined.json --json
cld grids tables combined get Reporting "All inventory" --json
cld grids tables combined publish Reporting "All inventory" --json

cld grids tables combined publications "Warehouse East" Items --json
cld grids tables combined revoke "Warehouse East" Items \
  --target-table <combined-table-id> \
  --yes

cld grids records audit list Reporting "All inventory" --action deleted
```

**Verständlicher Zuordnungsinhalt**

```text
{
  "sources": [
    {
      "base": "Warehouse East",
      "table": "Items",
      "mappings": [
        { "target": "Name", "source": "Title" },
        {
          "target": "Status",
          "source": "State",
          "options": { "In stock": "Available" }
        }
      ]
    }
  ]
}
```

:::note Kontrolle durch die Quelladministration
Personen mit Administratorrechten für die Quelle können Freigaben mit `cld grids tables combined publications` prüfen und eine Freigabe mit `cld grids tables combined revoke` widerrufen. Der revoke-Befehl löst die gespeicherte Quelle aus seinen Argumenten für Basis und Tabelle auf und übernimmt die öffentliche ID der kombinierten Tabelle aus `--target-table`. Der Widerruf macht die Zielrevision sofort unverfügbar.
:::
