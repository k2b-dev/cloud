---
id: spaces-sharing
title: Space teilen und Einstellungen ändern
icon: ti ti-lock
description: Gib Personen die passende Zugriffsstufe, ändere die Space-Einstellungen und teile Kalenderexporte sicher.
order: 130
---

Gib jeder Person und Gruppe nur den Zugriff, den sie in diesem Space braucht.

## Space-Einstellungen öffnen {icon="settings"}

Wähle in der Seitenleiste des Space **Space-Einstellungen**. Die Einstellungen öffnen sich in einem Dialog. So kehrst du zur aktuellen Ansicht zurück, ohne den Space zu verlassen.

Die Kategorien ordnen die Einstellungen nach Zuständigkeit und Auswirkung:

- **Space** enthält den gemeinsamen Namen und die Angaben, Tags und Workflow-Status.
- **Persönlich** enthält deine Browser-Voreinstellungen. Sie gelten sofort und nur für dich.
- **Verbindungen** enthält das Kalender-Abonnement, die Wormholes und das GitHub-Token für Linkvorschauen. Wormholes und Token ändern nur Personen mit Zugriff **Verwalten**.
- **Freigabe** enthält Zugriff und API-Schlüssel. Sie ist für Personen mit Zugriff **Verwalten**.
- **Verwaltung** enthält das endgültige Löschen des Space.

Formulare mit einer Fußzeile zeigen die Anzahl der Änderungen. Prüfe diese Zahl und wähle **Änderungen speichern**. Aktionen in einer Liste, etwa einen Status hinzufügen, einen Zugriff ändern oder einen Schlüssel widerrufen, speichern sofort nach deiner Bestätigung.

## Zugriffsstufe wählen {icon="shield-lock"}

:::reference
- **Ansehen:** Den Space und seine Einträge sehen. Eigene Voreinstellungen ändern und das Kalender-Abonnement kopieren.
- **Bearbeiten:** Zusätzlich Einträge, Kommentare, Status, Datumsangaben und Zuständigkeiten erstellen und ändern. Angaben zum Space, Tags, Status, die automatischen Kanban-Spalten und die Spaltenreihenfolge ändern.
- **Verwalten:** Zusätzlich Wormholes, GitHub-Token, Zugriff, API-Schlüssel, den Kalenderexport und das Löschen ändern.
:::

## GitHub-Token hinterlegen {icon="brand-github"}

Das GitHub-Token ist optional und gehört zu einem Space. Spaces speichert es verschlüsselt und nutzt es nur für Vorschauen von GitHub-Links an Einträgen dieses Space. Spaces zeigt das Token nie wieder an.

Verwende bevorzugt ein fein abgestuftes Token, das nur Issues und Pull Requests der Repositories lesen kann, an denen der Space arbeitet. Entferne das Token, wenn du es nicht mehr brauchst.

## Kalenderexport teilen {icon="calendar-share"}

Nutze den Kalenderexport, wenn geplante Arbeit in einem externen Kalender erscheinen soll. Behandle eine Export-URL wie einen Zugriff, mit dem jemand die Termindetails lesen kann.
