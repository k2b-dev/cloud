---
id: notebooks-core-model
title: "Grundmodell"
icon: "ti ti-components"
description: "Notizbücher, Notizen, benannte Daten, Abfragen und Anhänge verstehen."
order: 110
---

Ein Notizbuch ist ein gemeinsamer Arbeitsbereich. Eine Notiz ist ein Markdown-Quelldokument darin. Benannte Daten und Abfragen ergänzen Struktur und ersetzen diesen Quelltext nicht.

## Die Objekte kennen {icon="box-multiple"}

:::reference
- **Notizbuch:** Ein Arbeitsbereich mit Notizen, Anhängen, Einstellungen, Zugriff und Exporten. Seine sechsstellige ID ändert sich nie und erscheint in URLs und APIs.
- **Notiz:** Ein Markdown-Dokument mit Text, Aufgaben, Links, Tabellen, Daten und Anhängen. Seine sechsstellige ID ändert sich nie und erscheint in URLs und Notizlinks.
- **Notizbaum:** Eine Notiz kann eine übergeordnete Notiz haben. Navigation und Abfragen können diese Hierarchie nutzen.
- **Startseite:** Die Startseite steht im Notizbaum der Seitenleiste an erster Stelle ihrer Ebene und zeigt ein Haus-Symbol. Lege sie unter **Einstellungen → Notizbuch → Allgemein** fest.
- **Tag:** Ein #tag im Notiztext gruppiert Notizen für Suche, Tagseiten und Abfragen.
- **Anhang:** Eine Datei, die du ins Notizbuch hochlädst. Notizen verweisen mit attach://shortId darauf.
- **Benannter Block:** Schreibe @name direkt über eine Tabelle, eine Liste, einen Datenblock oder einen Abschnitt. So bekommt der Block einen stabilen Namen.
- **Abfrage:** Ein `:::query`-Block listet Notizen aus diesem Notizbuch auf. Er filtert nach Tags, Titel oder eigenen benannten Daten.
- **Inhaltsverzeichnis:** Ein `:::toc`-Block verlinkt die Überschriften der aktuellen Notiz.
:::

## Eine von drei Ansichten wählen {icon="book"}

:::reference
- **Bearbeiten:** Den Markdown-Text gemeinsam mit anderen bearbeiten.
- **Schreibgeschützt:** Arbeitsbereich und Detailbereich behalten, ohne den Notiztext zu bearbeiten.
- **Buch:** Die Notiz als Webseite mit Navigation und Tagfiltern lesen. Buch hat keinen Editor und keinen Diskussionsbereich.
:::

Zugriff **Ansehen** öffnet immer die Buchansicht. Mit Zugriff **Bearbeiten** oder **Verwalten** wechselst du die Ansicht. Personen mit Zugriff **Verwalten** wählen die gemeinsame Standardansicht in den Einstellungen. Eine Ansicht in der URL hat Vorrang vor der Standardansicht. Gesperrte Notizen öffnen in **Schreibgeschützt** statt in **Bearbeiten**.

Halte wichtige Informationen im Markdown sichtbar. Abfragen lesen gespeicherte Notizdaten. Sie führen keinen Code aus, ändern keine Seiten und erzeugen keinen versteckten Zustand.
