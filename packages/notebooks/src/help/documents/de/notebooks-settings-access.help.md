---
id: notebooks-settings-access
title: "Einstellungen und Zugriff"
icon: "ti ti-settings"
description: "Standardansicht, Details, Berechtigungen, Exporte und Skripte eines Notizbuchs konfigurieren."
order: 170
---

Öffne **Einstellungen** in der Seitenleiste. Das Dialogfenster lässt die aktuelle Notiz an ihrer Position.
Wechsle aus der Ansicht **Buch** zuerst zu **Bearbeiten** oder **Schreibgeschützt**. Diese Ansichten sind für Nutzer mit Schreib- oder Adminrechten verfügbar.

## Standardansicht wählen {icon="book"}

Nutzer mit Leserechten sehen immer **Buch**: eine Leseansicht mit Seitennavigation und Tagfiltern, ohne Bearbeitungswerkzeuge, Detailbereich oder Seitendiskussion. Abfrageblöcke (`:::query`) und Inhaltsverzeichnisse (`:::toc`) werden zusammen mit der Seite auf dem Server gerendert. Mermaid-Diagramme entstehen im Browser; ohne JavaScript oder bei einem Darstellungsfehler bleibt ihr Quelltext lesbar.

Nutzer mit Schreib- oder Adminrechten können zwischen drei Ansichten wechseln:

- **Bearbeiten:** Die Notiz bearbeiten und den Detailbereich nutzen.
- **Schreibgeschützt:** Den Arbeitsbereich mit Detailbereich nutzen, ohne den Notiztext zu bearbeiten.
- **Buch:** Das Notizbuch als Handbuch ohne Editor-Arbeitsbereich lesen.

Unter **Notizbuch – Ansicht und Verhalten** legen Admins die **Standardansicht** für Nutzer mit Schreib- oder Adminrechten fest. Die Änderung wird sofort gespeichert. Anfangs öffnen diese Nutzer das Notizbuch zum Bearbeiten. Eine ausdrücklich in der Seiten-URL gewählte Ansicht hat Vorrang vor der Standardansicht.

Gesperrte Notizen öffnen sich in der Ansicht **Schreibgeschützt** statt zum Bearbeiten. Die Seitendiskussion im Detailbereich bleibt trotz Sperre verfügbar.

## Bereiche der Einstellungen {icon="settings"}

:::reference
- **Notizbuch – Allgemein:** Name, Symbol, Beschreibung, Startseite und Liquid-Vorlage für die erste Überschrift neuer leerer Notizen. Änderungen werden gemeinsam gespeichert oder verworfen.
- **Notizbuch – Ansicht und Verhalten:** Admins wählen die gemeinsame Standardansicht und aktivieren bei Bedarf Skripte. Das Seitenleistenlayout gilt für diesen Browser.
- **Freigabe – Zugriff:** Admins verwalten Berechtigungen; Änderungen werden sofort gespeichert.
- **Freigabe – API-Schlüssel:** Admins verwalten an das Notizbuch gebundene Zugangsdaten. Neue Tokens werden nur einmal angezeigt.
- **Daten – Export und Snapshots:** Admins erstellen portable ZIP-Exporte, konfigurieren S3-Snapshots und prüfen die letzten Läufe.
- **Verwaltung – Endgültig löschen:** Dauerhafte Aktionen wie das Löschen des Notizbuchs und seiner Notizen.
:::

## Skripte sicher verwenden {icon="shield-lock"}

:::warning Skripte nur in vertrauenswürdigen Notizbüchern aktivieren
Skripte können im Editor-Arbeitsbereich laufen, sichtbare Inhalte lesen und mit den Berechtigungen der jeweiligen Person Notizbuchaktionen ausführen. Die Ansicht Buch zeigt den Skriptquelltext, ohne ihn auszuführen.
:::
