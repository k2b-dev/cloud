---
id: grids-combined-tables
title: Kombinierte Tabellen
icon: ti ti-table-share
description: Veröffentliche eine zentral geregelte, schreibgeschützte Tabelle aus mehreren Bases.
order: 122
---
Eine kombinierte Tabelle zeigt Datensätze aus mehreren gespeicherten Tabellen als eine zentral geregelte, schreibgeschützte Tabelle. Nutze sie, wenn Teams weiter in getrennten Bases arbeiten, aber eine andere Zielgruppe einen einheitlichen Datenbestand braucht. Diese Zielgruppe kann ihn für Audit, Berichte, Suche, Grids Apps, Dokumente, Workflows oder Exporte nutzen.

Regionale Teams führen zum Beispiel verschiedene Bases für ihren Bestand, und eine Audit-Base veröffentlicht eine Tabelle **Gesamtbestand**. Personen fragen deren kanonische Felder Name, Status und Standort ab, auch wenn die Quelltabellen andere Namen oder Auswahloptionen verwenden.

Nutze keine kombinierte Tabelle, nur um eine Teilmenge einer einzelnen Tabelle zu zeigen. Dafür gibt es Ansichten. Nutze sie auch nicht, wenn Personen die Quelldatensätze darüber bearbeiten müssen, denn die Veröffentlichung ist bewusst schreibgeschützt.

## Verstehen, was eine kombinierte Tabelle ändert {icon="table"}

Die Ziel-Base besitzt die kombinierte Tabelle, ihre kanonischen Felder und ihre Ansichten. Personen mit Zugriff **Verwalten** auf eine Quell-Base autorisieren ausdrücklich ausgewählte Quelltabellen und Feldzuordnungen. Personen mit Zugriff auf die Ziel-Base oder auf eine Grids App mit dem kombinierten Ergebnis brauchen keinen Zugriff auf die Quell-Bases. Suche, Filter, Sortierung, Seitennavigation, Gruppierung, Aggregation, Grids Apps und Exporte funktionieren über alle veröffentlichten Quellen wie bei einer gespeicherten Tabelle.

:::reference
- **Kanonische Felder:** Erstelle die Felder, die Personen sehen. Ordne danach jedes Quellfeld dem passenden kanonischen Feld zu. Eine fehlende Zuordnung liefert für diese Quelle null.
- **Unabhängige Veröffentlichung:** Personen mit Zugriff auf das Ziel erhalten nur kanonische Daten. Sie erhalten weder die Navigation der Quelle noch verborgene Quellfelder oder das Recht zu bearbeiten.
- **Schreibgeschütztes Ergebnis:** Verwende die Tabelle in GQL, gespeicherten Ansichten, Grids Apps, Dokumenten, Workflows und Exporten. Datensätze erstellen, Formulare, Importe, Uploads, Bearbeitungen und Löschungen sind nicht verfügbar.
- **Sperre bei Fehlern:** Eine widerrufene, gelöschte oder inkompatible Quelle macht die gesamte veröffentlichte Revision unverfügbar. Grids liefert nie unbemerkt ein kleineres Teilergebnis.
:::

## Eine kombinierte Tabelle erstellen und veröffentlichen {icon="square-plus"}

Du brauchst Zugriff **Verwalten** auf die Ziel-Base. Für eine neue Quelle brauchst du außerdem Zugriff **Verwalten** auf die Quell-Base.

:::steps
1. **Erstelle die Tabelle:** Wähle **Neue Tabelle** und dann **Kombinierte Tabelle**.
2. **Füge kanonische Felder hinzu:** Lege die Felder an, die später abgefragt werden.
3. **Wähle Quellen:** Öffne im **Bearbeitungsmodus** den Bereich **Kombinierte Daten**. Die Auswahl zeigt nur gespeicherte Tabellen aus Bases, auf die du Zugriff **Verwalten** hast.
4. **Ordne Felder zu:** Ordne stabile Quellfelder anhand ihrer Identität zu.
5. **Ordne Auswahloptionen zu:** Ordne bei jedem Auswahlfeld jede Quelloption ausdrücklich zu.
6. **Validiere:** Die Validierung meldet unvollständige oder inkompatible Zuordnungen. Die aktive Veröffentlichung ändert sie nicht.
7. **Veröffentliche:** Veröffentliche erst, wenn du alle Diagnosen behoben hast.
8. **Gib Zugriff:** Gib Zugriff auf die Ziel-Base oder nimm das Ergebnis in eine Grids App auf.
:::

Personen mit Zugriff **Verwalten** auf eine Quell-Base können den genau veröffentlichten Feldumfang prüfen und unabhängig widerrufen.

:::note Wer veröffentlichen darf
Das Veröffentlichen erfordert immer Zugriff **Verwalten** auf die Ziel-Base. Zugriff **Verwalten** auf die Quell-Base ist nur für neuen oder erweiterten Quellumfang nötig und für die Wiederherstellung nach einem Widerruf. Bestehende, nicht widerrufene Zuordnungen kannst du ohne neue Autorisierung beibehalten, einschränken oder entfernen. Eine veröffentlichte Autorisierung bleibt gültig, wenn die autorisierende Person diesen Zugriff später verliert. Eine Person mit Zugriff **Verwalten** auf die Quell-Base kann sie ausdrücklich widerrufen.
:::

## Die Tabelle abfragen und weiterverwenden {icon="search"}

GQL hat keine besondere Syntax für kombinierte Tabellen. Die Autovervollständigung zeigt nur die kanonischen Zielfelder. Dieselbe Abfrage kann eine Datensatzseite, eine gespeicherte Ansicht, einen Grids-App-Block, eine Dokumentquelle, einen Lesevorgang eines Workflows oder einen Streaming-Export versorgen.

**Unternehmensweiter Bestand**

```gql
from table "All inventory"
where Status = 'Available'
search 'camera'
sort Name asc
```

:::reference
- **Relationen:** Eine kanonische Relation muss auf ein gemeinsames gespeichertes Ziel verweisen oder auf ein anderes ausdrücklich veröffentlichtes kombiniertes Ziel mit den verknüpften Datensätzen.
- **Dateien:** Personen mit Zugriff auf die Ziel-Base und kompilierte Grids-App-Capabilities können zugeordnete Dateien innerhalb der Veröffentlichungsgrenze ansehen und herunterladen. Dateimetadaten und Dateiänderungen der Quelle bleiben privat.
- **Berechnete Daten:** Zugeordnete Ergebnisse brauchen kompatible Typen. Finalisierte Quellwerte bleiben eingefroren. Kanonische Formeln rechnen trotzdem damit.
- **Objektlisten:** Quelle und Ziel brauchen identische Spaltendefinitionen, einschließlich IDs, Typen, Einheiten und Berechnungen. Einzelne Unterspalten lassen sich nicht zuordnen.
- **Live-Daten und Exporte:** Änderungen an der Quelle erscheinen automatisch. CSV- und JSON-Exporte können über alle passenden Datensätze fortgesetzt werden.
:::

## Diagnosen beheben {icon="lifebuoy"}

Diagnosen für den Entwurf nennen die betroffene Quelle, das kanonische Feld und das Quellfeld. Eine veröffentlichte Tabelle zeigt **Aktion erforderlich**, wenn ihre Felder oder ihr Zugriff auf eine Quelle nicht mehr gültig sind.

:::steps
1. Repariere die Quelle oder die Zuordnungen.
2. Validiere den Entwurf.
3. Veröffentliche eine vollständige neue Revision.
:::

Widerrufener Zugriff kehrt erst zurück, wenn du eine neu autorisierte Revision veröffentlichst.

:::reference
- **Keine automatische Zuordnung:** Grids rät nie anhand von Bezeichnungen, Positionen oder ähnlichen Feldtypen. Jede veröffentlichte Zuordnung ist beabsichtigt.
- **Keine verschachtelten kombinierten Quellen:** Eine kombinierte Tabelle kann nur gespeicherte Tabellen als Quellen verwenden. Nutze eine kanonische Relation, wenn auch verknüpfte Datensätze zusammengeführt werden müssen.
- **Kein Schreiben in Quellen:** Eine kombinierte Tabelle kann ihre Quelldatensätze nicht bearbeiten. Workflows können kombinierte Daten lesen, aber das kombinierte Ziel nicht ändern.
- **Ausdrückliche Grenzen:** Eine kombinierte Tabelle unterstützt bis zu 50 Quelltabellen und 200 kanonische Felder.
:::

## Gelöschte Datensätze und Verlauf prüfen {icon="history"}

Kombinierte Tabellen erhalten den Lebenszyklus veröffentlichter Datensätze, ohne Zugriff auf ihre Quell-Bases zu geben. Eine Person mit Zugriff auf die Ziel-Base kann **Gelöschte anzeigen** wählen, um Datensätze zu prüfen, die in einer Quelltabelle gelöscht wurden. Ihre Detailansicht ist schreibgeschützt und nennt die veröffentlichte Quelle mit dem Namen von Base und Tabelle. Um den ursprünglichen Datensatz wiederherzustellen oder zu bearbeiten, nutze seine Quell-Base.

Die Detailansicht des Datensatzes zeigt seinen veröffentlichten Verlauf. Personen mit Zugriff auf die Ziel-Base können außerdem **Aktionen → Änderungsverlauf** wählen, um den Verlauf aller veröffentlichten Datensätze zu durchsuchen und zu filtern. Eine Person, die eine Grids App verwendet, erhält nur den Verlauf, den der veröffentlichte Capability-Snapshot ausdrücklich enthält.

:::reference
- **Aktuelle Veröffentlichung:** Grids projiziert den Verlauf durch die aktiven kanonischen Zuordnungen. Aus der Veröffentlichung entfernte Felder erscheinen nicht mehr, auch nicht in älteren Ereignissen.
- **Lebenszyklusereignisse:** Ereignisse für Erstellen, Ändern, Importieren, Löschen und Wiederherstellen bleiben sichtbar, solange ihre Quelle aktiv veröffentlicht ist.
- **Erforderliche Erklärungen:** Antworten, die eine Audit-Richtlinie erfasst, etwa ein erforderlicher Löschgrund, bleiben mit den Bezeichnungen ihrer Fragen am Ereignis.
- **Private Quelldetails:** Die kombinierte Tabelle legt keine nicht veröffentlichten Felder und Werte, keine technischen Anfragedetails und nicht die Navigation der Quell-Base offen.
- **Geänderte Auswahloptionen:** Eine alte Quelloption ohne aktive kanonische Zuordnung erscheint als nicht verfügbar. Ihre Quellkennung legt Grids nicht offen.
- **Sperre bei Fehlern:** Widerrufene, beeinträchtigte oder inkompatible Veröffentlichungen liefern keinen Teilverlauf. Repariere die kombinierte Tabelle und veröffentliche sie erneut, bevor du weitermachst.
:::

## Den Lebenszyklus über die CLI steuern {icon="code"}

Die CLI akzeptiert exakte Namen oder 6-stellige öffentliche IDs. Der Zuordnungsinhalt ist JSON, keine eigene Konfigurationssprache. Führe `cld grids tables combined candidates` aus, um Quellen zu finden, die du autorisieren kannst. Validiere vor dem Speichern oder Veröffentlichen.

**Erstellen, prüfen, veröffentlichen und widerrufen**

```text
cld grids tables add Reporting --name "All inventory" --kind federated --json
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

:::note Eine Quell-Base kontrollieren
Personen mit Zugriff **Verwalten** auf eine Quell-Base können ihre Veröffentlichungen mit `cld grids tables combined publications` prüfen. Mit `cld grids tables combined revoke` widerrufen sie eine davon. Der revoke-Befehl ermittelt die gespeicherte Quelle aus seinen Argumenten für Base und Tabelle. Die öffentliche ID der kombinierten Tabelle nimmt er aus `--target-table`. Ein Widerruf macht die Zielrevision sofort unverfügbar.
:::
