---
id: grids-overview
title: Überblick
icon: ti ti-layout-grid
description: Verstehe, wofür Grids gedacht ist und wie du beginnst.
order: 100
---
Mit Grids verwaltet ein Team strukturierte Informationen und die zugehörige Arbeit an einem Ort. Du kannst Bestände, Rechnungen, Projekte, Anfragen, Kunden, Verträge oder andere Prozesse abbilden, bei denen jeder Eintrag einer einheitlichen Struktur folgt.

Für den Einstieg brauchst du keine Datenbankkenntnisse. Eine **Basis** ist der Arbeitsbereich für ein Thema. Darin listet eine **Tabelle** eine bestimmte Art von Einträgen auf, ein **Datensatz** ist ein einzelner Eintrag in dieser Liste und ein **Feld** speichert eine Information zu diesem Eintrag.

Eine Basis für die Bestandsverwaltung könnte beispielsweise separate Tabellen für Gegenstände, Standorte, Ausleihen und Personen enthalten. Ein Datensatz in der Tabelle für Gegenstände könnte einen Namen, eine Inventarnummer, einen Status, einen Standort und eine Relation zur aktuellen Ausleihe enthalten.

## Was du erstellen kannst {icon="square-plus"}

Sobald die Datensätze nützlich sind, können dieselben gespeicherten Daten verschiedene Aufgaben unterstützen:

- **Ansichten** zeigen die Datensätze, die Personen für eine Aufgabe benötigen, etwa verfügbare Gegenstände oder überfällige Ausleihen.
- **Formulare** bieten eine gezielte Möglichkeit, Datensätze anzulegen, ohne die vollständige Tabelle zu öffnen.
- **Grids Apps** verbinden Kennzahlen, Diagramme, Datensatzlisten, Formulare, Anleitungen, Links und Workflow-Aktionen in serverseitig abgesicherten Seiten für angemeldete oder öffentliche Zielgruppen, ohne den vollständigen Base-Arbeitsbereich zu öffnen.
- **Dokumente** bewahren erzeugte PDF-, CSV-, JSON-, XML-, SEPA- und DATEV-Dateien mit ihren erfassten Quelldaten auf.
- **Workflows** führen wiederholbare Schritte manuell, nach einem Scan oder einer Auswahl, nach Zeitplan oder nach einer Änderung an einem Datensatz aus.
- **Kombinierte Tabellen** veröffentlichen aus Tabellen mehrerer Basen einen zentral geregelten, schreibgeschützten Datenbestand.

Diese Funktionen erstellen keine separaten Kopien der Geschäftsdaten. Die Tabellen bleiben die maßgebliche Datenquelle.

## Mit einem nützlichen Prozess beginnen {icon="square-plus"}

Wähle einen kleinen Prozess mit bereits klar definierten Einträgen, etwa Geräteausleihen oder eingehende Anfragen. Gehe dann so vor:

:::steps
1. Erstelle eine Tabelle für die wichtigste Art von Einträgen.
2. Füge nur die Felder hinzu, die zum Erkennen und Bearbeiten der einzelnen Datensätze nötig sind.
3. Erfasse einige echte Datensätze und korrigiere unklare Namen oder Feldtypen.
4. Erstelle eine Ansicht für eine wiederkehrende Aufgabe.
5. Füge ein Formular, eine Grids App, ein Dokument oder einen Workflow erst hinzu, wenn dadurch ein konkreter manueller Schritt entfällt.
:::

## Alle Themen

- [Bases, Tabellen, Datensätze und Relationen](/app/grids/help/grids-core-model)
- [Base aufbauen und Einstellungen wählen](/app/grids/help/grids-build-base)
- [Vorlagen und Abläufe: Abrechnung, Auslagen, Inventar](/app/grids/help/grids-build-business-app)
- [Tabellenoptionen, Indizes, Historie, Finalisierung und Vier Augen](/app/grids/help/grids-tables-fields)
- [Alle Feldtypen, ID-Strategien, Optionen und Standardwerte](/app/grids/help/grids-field-configuration)
- [Importe, externe Identitäten und CSV-/JSON-Exporte](/app/grids/help/grids-data-exchange)
- [Ansichten, Diagramme, Karten, Kalender und Berichte](/app/grids/help/grids-views-reports)
- [Lesende Datenbestände aus mehreren Bases](/app/grids/help/grids-combined-tables)
- [GQL-Syntax, Joins, unabhängige Summen und Dokumentmetadaten](/app/grids/help/grids-gql)
- [Formelfunktionen, Typen, exakte Dezimalwerte und Diagnosen](/app/grids/help/grids-formulas)
- [Formulare, kompaktes Layout, Standards, Inline-Erstellung und Zusammenfassungen](/app/grids/help/grids-forms)
- [Was eine Grids App ist](/app/grids/help/grids-custom-apps)
- [Eine fokussierte Anwendung aufbauen](/app/grids/help/grids-build-custom-app)
- [Seiten, Parameter, Blöcke, Abfragen und Navigation](/app/grids/help/grids-custom-app-pages-blocks)
- [Vollständiger App-API- und Konfigurationsvertrag](/app/grids/help/grids-custom-app-api)
- [YAML prüfen, planen, anwenden und wiederherstellen](/app/grids/help/grids-custom-app-yaml-cli)
- [Sicher veröffentlichen und jede Zielgruppe prüfen](/app/grids/help/grids-publish-custom-app)
- [Vorlagen, PDF/E-Rechnungen, erzeugte Dateien und Quelldatensätze](/app/grids/help/grids-documents-pdfs)
- [Aktionen, Trigger, Starter, Dateiausgaben, Bestätigungen und Wiederholung](/app/grids/help/grids-workflows)
- [Eingaben, Grenzen und Prüfung der Finanzformate](/app/grids/help/grids-financial-formats)
- [Base-Rechte, App-Zielgruppen und anonyme Formulare](/app/grids/help/grids-permissions)
- [Aufbewahrung, Sperren, Papierkorb und Vernichtung](/app/grids/help/grids-retention-preservation)
- [Evidence-Exporte und Integritätsprüfung](/app/grids/help/grids-evidence-exports)
- [Fehler, Konflikte und unterbrochene Läufe beheben](/app/grids/help/grids-operations-troubleshooting)

In dieser Reihenfolge bleiben Fehler kostengünstig. Eine klare Tabelle und einige repräsentative Datensätze erleichtern alle späteren Entscheidungen.

## In einer Base zurechtfinden {icon="layout-dashboard"}

Wechsle unter **Übersicht** zwischen **Gruppen** für gemeinsame Schnellzugriffe und **Alle Ressourcen** mit Suche nach Name oder Typ. Der ausgewählte Tab steht in der URL und bleibt beim Teilen, Neuladen sowie Vor- und Zurücknavigieren erhalten. Bases mit Gruppen öffnen standardmäßig **Gruppen**, sonst **Alle Ressourcen**. Formulare öffnen weiterhin ihren Dialog.

Über **Neu** im Bearbeitungsmodus erstellst du Tabellen, Ansichten, Formulare, Dokumentvorlagen, Workflows oder Apps. Die Auswahl zeigt nur erlaubte Aktionen. Bei tabellenbezogenen Ressourcen wählst du eine Tabelle; die aktuelle Tabelle ist vorausgewählt, sofern sie geeignet ist. **Ansicht** öffnet den Abfrageeditor, in dem du die Ansicht konfigurierst und speicherst.

**Dokumente** lässt sich immer aufklappen: Öffne **Alle Dokumente** oder wähle eine Vorlage für deren erzeugte Dokumente. Base-Admins verwalten Workflow-E-Mail-Vorlagen unter **Einstellungen → E-Mail-Vorlagen**.

Base-Admins können unter **Einstellungen → Navigation** Gruppen anlegen. Füge Ressourcen über die durchsuchbare Auswahl hinzu, ändere ihre Reihenfolge mit den Pfeil-Schaltflächen und speichere deine Änderungen. Das Entfernen eines Schnellzugriffs oder einer Gruppe löscht keine Ressource. Eine Ressource darf in mehreren Gruppen vorkommen.

Die Gruppen gelten gemeinsam, aber jeder sieht nur zugängliche Ressourcen. Leere Gruppen bleiben verborgen. Ohne sichtbare Gruppen bleiben die übrigen Ressourcenlisten offen. Mit Gruppen lassen sie sich aufklappen und enthalten weiterhin alle zugänglichen Ressourcen, auch die bereits gruppierten. Dieser Browser merkt sich den Klappzustand; ein direkter Link macht die aktive Ressource sichtbar.

Hat ein anderer Admin inzwischen gespeichert, wird dein Speichern abgelehnt statt dessen Änderungen zu überschreiben. **Navigation neu laden** lädt den aktuellen Stand und fragt vor dem Verwerfen deiner Änderungen nach.

## So geht es weiter {icon="arrow-right"}

- Lies **Kernmodell**, wenn Basen, Tabellen, Datensätze und Relationen neu für dich sind.
- Folge **Eine Basis erstellen**, um deine erste Basis praktisch aufzubauen.
- Nutze **Tabellen und Felder**, wenn du entscheidest, wie ein Wert gespeichert werden soll.
- Öffne das Thema einer Funktion, sobald du sie hinzufügen möchtest.

:::note Bearbeitungsmodus
Im Normalmodus verwendest du eine Basis. Aktiviere den **Bearbeitungsmodus**, wenn du ihre Struktur, Ressourcen oder Einstellungen ändern musst. Was du sehen und ändern kannst, hängt weiterhin von deinen Zugriffsrechten ab.
:::
