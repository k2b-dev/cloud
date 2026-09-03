---
id: notebooks-core-model
title: "Grundmodell"
icon: "ti ti-components"
description: "Notizbücher, Notizen, benannte Daten, Abfragen und Anhänge verstehen."
order: 110
---

Ein Notizbuch ist ein gemeinsamer Arbeitsbereich. Eine Notiz ist sein Markdown-Quelldokument. Benannte Daten und Abfragen ergänzen Struktur, ohne diesen Quelltext zu ersetzen.

## Die Objekte {icon="box-multiple"}

:::reference
- **Notizbuch:** Ein Arbeitsbereich mit Notizen, Anhängen, Einstellungen, Berechtigungen und Exporten. Seine unveränderliche sechsstellige ID erscheint in URLs und APIs.
- **Notiz:** Ein Markdown-Dokument mit Text, Aufgaben, Links, Tabellen, Daten und Anhängen. Seine unveränderliche sechsstellige ID erscheint in URLs und Notizlinks.
- **Notizbaum:** Notizen können übergeordnete Notizen haben. Navigation und Abfragen können diese Hierarchie nutzen.
- **Tag:** Ein #tag im Notiztext gruppiert Notizen für Suche, Tagseiten und Abfragen.
- **Anhang:** Eine ins Notizbuch hochgeladene Datei, die mit attach://shortId referenziert wird.
- **Benannter Block:** Schreibe @name direkt über eine Tabelle, Liste, einen Datenblock oder Abschnitt, um ihm einen stabilen Namen zu geben.
- **Abfrage:** Ein :::query-Block listet Notizen aus diesem Notizbuch auf, gefiltert nach Tags, Titel oder eigenen benannten Daten.
- **Inhaltsverzeichnis:** Ein :::toc-Block verlinkt Überschriften der aktuellen Notiz.
:::

## Eine Quelle, drei Ansichten {icon="book"}

**Bearbeiten** ermöglicht gemeinsames Schreiben im Markdown-Text. **Schreibgeschützt** behält den Arbeitsbereich mit Detailbereich bei, ohne den Notiztext zu bearbeiten. **Buch** zeigt die Notiz als Webseite mit Navigation und Tagfiltern, aber ohne Editor oder Diskussionsbereich.

Leserechte öffnen immer die Buchansicht. Nutzer mit Schreib- oder Adminrechten können wechseln; Admins wählen deren gemeinsame Standardansicht in den Einstellungen. Eine ausdrücklich in der URL gewählte Ansicht hat Vorrang. Gesperrte Notizen öffnen schreibgeschützt statt zum Bearbeiten.

Halte wichtige Informationen im Markdown sichtbar. Abfragen lesen gespeicherte Notizdaten; sie führen keinen Code aus, ändern keine Seiten und erzeugen keinen versteckten Zustand.
