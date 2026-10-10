---
id: notebooks-settings-access
title: "Einstellungen und Zugriff"
icon: "ti ti-settings"
description: "Standardansicht wählen und Details, Zugriff, das Löschen und Sperren von Notizen und Exporte eines Notizbuchs ändern."
order: 170
---

Für diese Einstellungen brauchst du Zugriff **Bearbeiten** oder **Verwalten**. Öffne **Einstellungen** in der Seitenleiste des Notizbuchs. Die Einstellungen öffnen sich in einem Dialog, deine aktuelle Notiz bleibt also an ihrer Stelle. Nutze in der Ansicht **Buch** zuerst den Stift, um eine nicht gesperrte Notiz zu bearbeiten.

## Festlegen, wie das Notizbuch öffnet {icon="book"}

Personen mit Zugriff **Ansehen** sehen immer **Buch**. Buch ist eine Leseansicht mit Seitennavigation und Tagfiltern. Sie hat keine Bearbeitungswerkzeuge, keinen Detailbereich und keine Seitendiskussion. Der Server rendert Abfrageblöcke (`:::query`) und Inhaltsverzeichnisse (`:::toc`) mit der Seite. Mermaid-Diagramme entstehen im Browser. Ohne JavaScript oder bei einem Darstellungsfehler bleibt ihr Quelltext lesbar.

In der Buchansicht aktualisieren Seitenlinks, Tagfilter, Suche und Seitennavigation den Inhalt ohne vollständiges Neuladen. **Zurück** und **Vorwärts** im Browser führen zu früheren Lesestellen. Gespeicherte Änderungen aktualisieren die Seite und die Abfrageergebnisse automatisch. Ohne JavaScript funktioniert die Navigation über normale Seitenaufrufe.

Wähle in der Seitenleiste der Buchansicht eine Seite aus, um sie zu öffnen. Mit dem Pfeil neben einer Seite blendest du ihre Unterseiten ein oder aus. Beim Laden zeigt die Buchansicht die aktuelle Seite mit ihren Unterseiten. Danach behält sie deine Auswahl und klappt nur die Seiten auf, in denen die geöffnete Seite liegt. Auf dem Smartphone zeigt das Navigationsmenü dieselben zugeklappten Seiten. Es behält sie beim Schließen und erneuten Öffnen und öffnet Seiten, ohne das Buch neu zu laden.

Die Seitenleiste zeigt die Startseite des Notizbuchs zuerst, mit ihren Unterseiten darunter. Das gilt auch, wenn die Startseite unter einer anderen Seite liegt. Alle weiteren Seiten folgen auf jeder Ebene der Reihenfolge des Notizbuchs:

- der Reihenfolge, die Personen mit Zugriff **Bearbeiten** oder **Verwalten** von Hand festgelegt haben;
- sonst nach Titel, sortiert für deine Sprache. Zahlen zählen als Zahlen, „Kapitel 2“ steht also vor „Kapitel 10“.

Die Reihenfolge passt sich an, wenn sich ein Titel, die Startseite oder die festgelegte Reihenfolge ändert. Lege die Startseite unter **Einstellungen → Notizbuch → Allgemein** fest. Wie du die Reihenfolge festlegst, steht unter **Notizen anordnen** in **Schreiben und ordnen**.

Öffnest du das Notizbuch selbst in der Buchansicht, zeigt sie die Startseite. Ohne Startseite zeigt sie die erste Seite der Seitenleiste. Hattest du zuletzt eine Seite dieses Notizbuchs in **Bearbeiten** oder **Schreibgeschützt** geöffnet, zeigt die Buchansicht diese Seite.

Mit Zugriff **Bearbeiten** oder **Verwalten** wechselst du zwischen drei Ansichten:

- **Bearbeiten:** Die Notiz bearbeiten und den Detailbereich nutzen.
- **Schreibgeschützt:** Arbeitsbereich und Detailbereich nutzen, ohne den Notiztext zu bearbeiten.
- **Buch:** Das Notizbuch als Handbuch lesen, ohne den Arbeitsbereich des Editors.

In der Ansicht **Bearbeiten** öffnet das Buchsymbol in der unteren Werkzeugleiste die Buchansicht. Der Detailbereich bietet auch Aktionen für Buch und **Schreibgeschützt**. Wähle in **Schreibgeschützt** im Detailbereich **Notiz bearbeiten**, um zurück zur Ansicht **Bearbeiten** zu wechseln.

In Buch und **Schreibgeschützt** erscheint unten rechts ein runder Stift, wenn du mit dem Mauszeiger über das Dokument fährst. Auch der Tastaturfokus zeigt ihn. Auf Touchgeräten bleibt er sichtbar. Gesperrte Notizen zeigen keine Bearbeitungsaktion.

Ist keine Notiz ausgewählt oder die Notiz gesperrt, zeigt Buch Personen mit Zugriff **Bearbeiten** oder **Verwalten** in der Seitenleiste **Arbeitsbereich öffnen**. Damit öffnest du die Einstellungen oder erstellst eine Notiz. Hast du die Navigation ausgeblendet, blende sie zuerst mit der Schaltfläche unten links ein.

Du brauchst Zugriff **Verwalten**, um die Standardansicht für Personen mit Zugriff **Bearbeiten** oder **Verwalten** zu ändern:

:::steps
1. Öffne **Einstellungen → Notizbuch → Ansicht und Verhalten**.
2. Ändere **Standardansicht**.
:::

Notebooks speichert die Änderung sofort. Anfangs ist die Standardansicht **Bearbeiten**. Eine Ansicht in der Seiten-URL hat Vorrang vor der Standardansicht des Notizbuchs.

Gesperrte Notizen öffnen in **Schreibgeschützt** statt in **Bearbeiten**. Eine Sperre nimmt dir nicht den Zugang zur Seitendiskussion im Detailbereich.

## Festlegen, wer Notizen löschen und sperren darf {icon="trash"}

:::warning Löschen und Sperren lassen sich nicht rückgängig machen
Anfangs können alle mit Zugriff **Bearbeiten** Notizen löschen und endgültig sperren.
:::

Mit Zugriff **Verwalten** schränkst du beides ein:

:::steps
1. Öffne **Einstellungen → Freigabe → Zugriff**.
2. Stelle **Wer darf Notizen löschen und sperren** auf **Nur Admins**.
:::

Notebooks speichert die Änderung sofort.

Die Einstellung betrifft nur das Löschen und Sperren ganzer Notizen. Personen und Agenten mit Zugriff **Bearbeiten** bearbeiten Notizen weiter wie bisher und können auch Text entfernen. Der Versionsverlauf bewahrt frühere Fassungen.

Für diese Personen bleiben **Löschen** und **Notiz sperren** im Notizmenü sichtbar, sind aber ausgeschaltet. Sie nennen den Grund: In diesem Notizbuch gilt dafür **Nur Admins**. Die API, `cld notebooks rm` und `cld notebooks lock` lehnen mit demselben Grund ab. Eine gesperrte Notiz behält ihre Versionen lesbar. Du kannst sie aber weder bearbeiten noch aus einer Version wiederherstellen.

## Den richtigen Bereich der Einstellungen finden {icon="settings"}

:::reference
- **Notizbuch → Allgemein:** Name, Symbol, Beschreibung, Startseite und die Liquid-Vorlage für die H1 neuer leerer Notizen. Prüfe die Fußleiste und speichere oder verwirf dann deine Änderungen.
- **Notizbuch → Ansicht und Verhalten:** Personen mit Zugriff **Verwalten** wählen die gemeinsame Standardansicht. Dieser Browser speichert dein Layout der Seitenleiste und deine Wahl für die Tab-Taste, und beides gilt sofort.
- **Freigabe → Zugriff:** Braucht Zugriff **Verwalten**. Ändere, wer Zugriff hat, und lege fest, wer Notizen löschen und sperren darf. Änderungen werden sofort gespeichert.
- **Freigabe → API-Schlüssel:** Braucht Zugriff **Verwalten**. API-Schlüssel für Integrationen, die nur mit diesem Notizbuch arbeiten. Änderungen werden sofort gespeichert, und Notebooks zeigt einen neuen Schlüssel nur einmal.
- **Daten → Export und Snapshots:** Braucht Zugriff **Verwalten**. Übertragbare ZIP-Exporte, die Einrichtung von S3-Snapshots, manuelle Uploads und die letzten Snapshot-Läufe. Speichere die Snapshot-Einrichtung über die Fußleiste.
- **Verwaltung → Endgültig löschen:** Braucht Zugriff **Verwalten**. Aktionen, die Daten zerstören, etwa das Löschen des Notizbuchs und seiner Notizen.
:::
