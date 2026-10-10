---
id: grids-overview
title: Überblick
icon: ti ti-layout-grid
description: Verstehe, wofür Grids gedacht ist und wie du beginnst.
order: 100
---
Mit Grids hält ein Team strukturierte Informationen und die zugehörige Arbeit an einem Ort. Du kannst Bestände, Rechnungen, Projekte, Anfragen, Kunden, Verträge oder jeden Prozess abbilden, in dem jeder Eintrag dieselbe Struktur hat.

Für den Einstieg brauchst du keine Datenbankkenntnisse. Eine **Base** ist der Arbeitsbereich für ein Thema. Darin listet eine **Tabelle** eine Art von Einträgen auf. Ein **Datensatz** ist ein Eintrag in dieser Liste. Ein **Feld** speichert eine Information zu diesem Eintrag.

Eine Base für den Bestand kann zum Beispiel getrennte Tabellen für Gegenstände, Standorte, Ausleihen und Personen enthalten. Ein Datensatz in der Tabelle für Gegenstände kann einen Namen, eine Inventarnummer, einen Status, einen Standort und eine Relation zur aktuellen Ausleihe enthalten.

## Sehen, was du erstellen kannst {icon="square-plus"}

Sobald die Datensätze nützlich sind, unterstützen dieselben gespeicherten Daten verschiedene Aufgaben:

- **Ansichten** zeigen die Datensätze, die Personen für eine Aufgabe brauchen, etwa verfügbare Gegenstände oder überfällige Ausleihen.
- **Formulare** lassen Personen Datensätze anlegen, ohne die vollständige Tabelle zu öffnen.
- **Grids Apps** verbinden Kennzahlen, Diagramme, Datensatzlisten, Formulare, Anleitungen, Links und Workflow-Aktionen auf Seiten, die der Server absichert. Sie dienen angemeldeten oder öffentlichen Zielgruppen und öffnen nicht den Base-Arbeitsbereich mit Rohdaten.
- **Dokumente** bewahren erzeugte PDF-, CSV-, JSON-, XML-, SEPA- und DATEV-Dateien zusammen mit ihren erfassten Quelldaten auf.
- **Workflows** führen wiederholbare Schritte aus: manuell, nach einem Scan oder einer Auswahl, nach Zeitplan oder nach einer Änderung an einem Datensatz.
- **Kombinierte Tabellen** veröffentlichen aus Tabellen mehrerer Bases einen zentral geregelten, schreibgeschützten Datenbestand.

Diese Funktionen erstellen keine separaten Kopien der Geschäftsdaten. Die Tabellen bleiben die maßgebliche Datenquelle.

## Mit einem nützlichen Prozess beginnen {icon="square-plus"}

Wähle einen kleinen Prozess mit bereits klaren Einträgen, etwa Geräteausleihen oder eingehende Anfragen. Gehe dann so vor:

:::steps
1. Erstelle eine Tabelle für die wichtigste Art von Einträgen.
2. Füge nur die Felder hinzu, die Personen brauchen, um jeden Datensatz zu erkennen und zu bearbeiten.
3. Erfasse einige echte Datensätze. Korrigiere unklare Namen oder Feldtypen.
4. Erstelle eine Ansicht für eine wiederkehrende Aufgabe.
5. Füge ein Formular, eine Grids App, ein Dokument oder einen Workflow erst hinzu, wenn dadurch ein echter manueller Schritt entfällt.
:::

In dieser Reihenfolge bleiben Fehler günstig. Eine klare Tabelle und einige repräsentative Datensätze erleichtern jede spätere Entscheidung.

## Alle Themen {icon="list"}

- [Bases, Tabellen, Datensätze und Relationen](/app/grids/help/grids-core-model)
- [Eine Base aufbauen und einstellen](/app/grids/help/grids-build-base)
- [Vorlagen und Abläufe: Abrechnung, Auslagen, Inventar](/app/grids/help/grids-build-business-app)
- [Tabellenoptionen, Indizes, Verlauf, Finalisierung und Vier Augen](/app/grids/help/grids-tables-fields)
- [Alle Feldtypen, ID-Strategien, Optionen und Standardwerte](/app/grids/help/grids-field-configuration)
- [Importe, externe Identitäten und CSV-/JSON-Exporte](/app/grids/help/grids-data-exchange)
- [Ansichten, Diagramme, Karten, Kalender und Berichte](/app/grids/help/grids-views-reports)
- [Schreibgeschützte Datenbestände aus mehreren Bases](/app/grids/help/grids-combined-tables)
- [GQL-Syntax, Joins, unabhängige Summen und Dokumentmetadaten](/app/grids/help/grids-gql)
- [Formelfunktionen, Typen, exakte Dezimalwerte und Diagnosen](/app/grids/help/grids-formulas)
- [Formulare, kompaktes Layout, Standardwerte, Inline-Erstellung und Zusammenfassungen](/app/grids/help/grids-forms)
- [Was eine Grids App ist](/app/grids/help/grids-custom-apps)
- [Eine gezielte App aufbauen](/app/grids/help/grids-build-custom-app)
- [Seiten, Parameter, Blöcke, Abfragen und Navigation](/app/grids/help/grids-custom-app-pages-blocks)
- [Vollständiger Vertrag für App-API und Konfiguration](/app/grids/help/grids-custom-app-api)
- [YAML prüfen, planen, anwenden und wiederherstellen](/app/grids/help/grids-custom-app-yaml-cli)
- [Sicher veröffentlichen und jede Zielgruppe prüfen](/app/grids/help/grids-publish-custom-app)
- [Vorlagen, PDFs und E-Rechnungen, erzeugte Dateien und Quelldatensätze](/app/grids/help/grids-documents-pdfs)
- [Aktionen, Trigger, Starter, Dateiausgaben, Bestätigungen und Wiederholungen](/app/grids/help/grids-workflows)
- [Eingaben, Grenzen und Prüfung der Finanzformate](/app/grids/help/grids-financial-formats)
- [Base-Zugriff, App-Zielgruppen und anonyme Formulare](/app/grids/help/grids-permissions)
- [Aufbewahrung, Sperren, Papierkorb und Vernichtung](/app/grids/help/grids-retention-preservation)
- [Nachweispakete und Integritätsprüfung](/app/grids/help/grids-evidence-exports)
- [Fehler, Konflikte und unterbrochene Läufe beheben](/app/grids/help/grids-operations-troubleshooting)

## Die Arbeit in einer Base finden {icon="layout-dashboard"}

Öffnest du Grids über die Navigation, kehrt Grids zur Base-Seite zurück, die du in diesem Browser zuletzt angesehen hast, auch in einem anderen Tab. Kannst du diese Base nicht mehr öffnen, erscheint stattdessen die Übersicht.

Mit **Neu** im **Bearbeitungsmodus** erstellst du eine Tabelle, Ansicht, ein Formular, eine Dokumentvorlage, einen Workflow oder eine App. Das Menü zeigt nur Aktionen, die du ausführen darfst. Für eine Ressource, die auf einer Tabelle beruht, wählst du eine Tabelle aus. Grids wählt die aktuelle Tabelle vor, wenn sie passt. **Ansicht** öffnet den Abfrageeditor, in dem du die Ansicht konfigurierst und speicherst.

**Dokumente** kannst du immer aufklappen. Öffne **Alle Dokumente** oder wähle eine Vorlage aus, um ihre erzeugten Dokumente zu sehen. E-Mail-Vorlagen für Workflows findest du unter **Einstellungen → E-Mail-Vorlagen**. Ansehen, Erstellen, Bearbeiten und Löschen erfordern Zugriff **Verwalten** auf die Base.

Wechsle unter **Übersicht** zwischen **Gruppen** für gemeinsame Schnellzugriffe und **Alle Ressourcen** für die Suche nach Name oder Typ. Der ausgewählte Tab steht in der URL. Links, Neuladen und der Browserverlauf behalten ihn deshalb. Standardmäßig öffnet eine Base mit Gruppen **Gruppen** und eine Base ohne Gruppen **Alle Ressourcen**. Ein Formular öffnet weiterhin seinen Dialog.

## Die Navigation in Gruppen ordnen {icon="layout-dashboard"}

Du brauchst Zugriff **Verwalten** auf die Base.

:::steps
1. Öffne **Einstellungen → Navigation**.
2. Lege eine benannte Gruppe an.
3. Füge Ressourcen über die durchsuchbare Auswahl hinzu.
4. Ändere ihre Reihenfolge mit den Pfeil-Schaltflächen.
5. Speichere deine Änderungen.
:::

Das Entfernen eines Schnellzugriffs oder einer Gruppe löscht keine Ressource. Eine Ressource kann in mehreren Gruppen vorkommen.

Gruppen gelten für alle, aber jede Person sieht nur die Ressourcen, auf die sie Zugriff hat. Grids blendet leere Gruppen aus. Ohne sichtbare Gruppen bleiben die übrigen Ressourcenlisten in der Seitenleiste offen. Mit Gruppen lassen sich diese Listen aufklappen. Sie enthalten weiterhin alle zugänglichen Ressourcen, auch die gruppierten. Dieser Browser merkt sich, welche Zweige du aufklappst. Ein direkter Link macht die aktive Ressource sichtbar.

Hat eine andere Person zuerst gespeichert, lehnt Grids dein Speichern ab und überschreibt ihre Änderungen nicht. **Navigation neu laden** lädt den aktuellen Stand. Vor dem Verwerfen deiner Änderungen fragt Grids nach.

## Mit dem nächsten Thema weitermachen {icon="arrow-right"}

- Lies [Das Kernmodell verstehen](/app/grids/help/grids-core-model), wenn Bases, Tabellen, Datensätze und Relationen neu für dich sind.
- Folge [Eine Base erstellen](/app/grids/help/grids-build-base), um deine erste Base praktisch aufzubauen.
- Nutze [Tabellen und Felder](/app/grids/help/grids-tables-fields), wenn du entscheidest, wie du einen Wert speicherst.
- Öffne das Thema einer Funktion, sobald du sie hinzufügen willst.

:::note Struktur im Bearbeitungsmodus ändern
Im Normalmodus verwendest du eine Base. Aktiviere den **Bearbeitungsmodus**, wenn du ihre Struktur, Ressourcen oder Einstellungen ändern musst. Was du sehen und ändern kannst, hängt weiterhin von deinem Zugriff ab.
:::
