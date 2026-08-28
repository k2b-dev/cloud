---
id: notebooks-settings-access
title: "Einstellungen und Zugriff"
icon: "ti ti-settings"
description: "Details, Berechtigungen, Exporte, Funktionen und Löschaktionen eines Notizbuchs konfigurieren."
order: 170
---

Öffne **Einstellungen** in der Seitenleiste. Das Dialogfenster lässt die aktuelle Notiz an ihrer Position.

## Bereiche der Einstellungen {icon="settings"}

:::reference
- **Notizbuch – Allgemein:** Name, Symbol, Beschreibung, Startseite und Liquid-Vorlage für die erste Überschrift neuer leerer Notizen. Änderungen werden gemeinsam gespeichert oder verworfen.
- **Notizbuch – Ansicht und Verhalten:** Das Seitenleistenlayout gilt für diesen Browser. Skriptblöcke sind gemeinsames Verhalten des Notizbuchs und erfordern Adminrechte.
- **Freigabe – Zugriff:** Admins verwalten Berechtigungen; Änderungen werden sofort gespeichert.
- **Freigabe – API-Schlüssel:** Admins verwalten an das Notizbuch gebundene Zugangsdaten. Neue Tokens werden nur einmal angezeigt.
- **Daten – Export und Snapshots:** Admins erstellen portable ZIP-Exporte, konfigurieren S3-Snapshots und prüfen die letzten Läufe.
- **Lebenszyklus – Gefahrenbereich:** Dauerhafte Aktionen wie das Löschen des Notizbuchs und seiner Notizen.
:::

## Skripte sicher verwenden {icon="shield-lock"}

:::warning Skripte nur in vertrauenswürdigen Notizbüchern aktivieren
Skripte laufen im Browser jeder Person, die die Notiz öffnet. Sie können sichtbare Inhalte lesen und mit den Berechtigungen dieser Person Notizbuchaktionen ausführen.
:::
