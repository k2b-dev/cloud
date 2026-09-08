---
id: grids-custom-apps
title: Grids Apps
icon: ti ti-app-window
description: Finde die passende Anleitung zum Erstellen, Veröffentlichen oder Verwenden einer Grids App.
order: 137
---
Grids Apps bieten angemeldeten oder öffentlichen Zielgruppen eine gezielte Anwendung unter `/apps/<id>`, ohne den vollständigen Grids-Arbeitsbereich freizugeben. Jede App gehört zu einer Basis und verwendet vorhandene Datensätze, Ansichten, Formulare, Dokumente und Workflow-Aktionen.

Apps kopieren keine Daten. Eine Veröffentlichung schreibt ihre Definition und die erlaubten Ressourcen fest. Jede Anfrage prüft die aktuelle App-Freigabe und die veröffentlichte Capability. Lesende Personen benötigen keinen Basiszugriff. Eine App-Freigabe erlaubt weder beliebiges GQL noch unmittelbaren Zugriff auf die Basis.

## Wähle den nächsten Schritt {icon="arrow-right"}

- [Eine Grids App erstellen](/app/grids/help/grids-build-custom-app): Erstelle eine Liste, einen Formularablauf und eine Datensatzdetailseite im visuellen Builder.
- [Seiten und Blöcke](/app/grids/help/grids-custom-app-pages-blocks): Wähle Blöcke, verknüpfe Datensatzparameter und konfiguriere bearbeitbare Felder, Dokumente und Aktionen.
- [YAML und CLI](/app/grids/help/grids-custom-app-yaml-cli): Verwende das vollständige Definitionsbeispiel zum Validieren, Planen, Anwenden und Exportieren.
- [Eine Grids App veröffentlichen](/app/grids/help/grids-publish-custom-app): Prüfe Zugriffe, veröffentliche einen Entwurf, stelle die aktive Version wieder her oder hebe die Veröffentlichung auf.

Zum Erstellen und Veröffentlichen benötigst du **Admin**-Zugriff auf die Basis. Lesende Personen verwenden nur die veröffentlichten Funktionen. Öffentliche Freigaben schließen anonyme Besucher ein; Workflow-Aktionen benötigen dennoch ein angemeldetes Konto.

## Eine App im Terminal verwenden {icon="terminal-2"}

Führe `cld grids apps runtime read <app-id> --json` mit der ID aus der App-URL aus. Das Ergebnis enthält sichtbare Seiten, Block-IDs, Daten, Formularfelder und verfügbare Aktionen. Du benötigst keinen Basiszugriff. Öffne eine Detailseite mit `--page <page-id> --params '{"request_id":"REC001"}'`. Verwende den Parameternamen und die Datensatz-ID aus der zurückgegebenen Navigation.

Die Befehle unter `apps runtime` lesen Datensatzseiten, senden Seiten- oder Seitenleistenformulare, ändern veröffentlichte bearbeitbare Felder, verwalten Kommentare und Anhänge, laden gespeicherte PDFs herunter, starten Aktionen oder Scanner und lesen ihren Laufstatus. `--help` erklärt die Eingaben. Seitenbezogene Befehle benötigen dieselben Parameter wie die Discovery.

Senden, Ändern, Scannen und Aktionen erfordern `--yes`. Formularübermittlungen sind nicht wiederholungssicher. Verwende dieselbe Operations-ID nur für die Wiederholung derselben Aktion. **Queued** bedeutet angenommen, nicht abgeschlossen: Lies den zurückgegebenen Laufstatus, bevor du über eine Wiederholung entscheidest.

Diese Befehle verwenden dieselben veröffentlichten App-Rechte wie der Browser. Sie umgehen keine nicht verfügbaren Blöcke. Fehlende, gelöschte, ungültige, nicht verfügbare oder nicht autorisierte Detaildatensätze liefern **Nicht gefunden**.

## Entwurf und Veröffentlichung trennen {icon="versions"}

Der Builder speichert vollständige Änderungen automatisch im Entwurf. Bearbeiten ändert nicht die aktive App. **Änderungen veröffentlichen** validiert und veröffentlicht den gespeicherten Entwurf. Behebe seine Diagnosen vor einem erneuten Versuch.

**Aktive Version wiederherstellen** verwirft ausstehende Entwurfsänderungen. Unter **App-Einstellungen → Lebenszyklus** entfernt das Aufheben der Veröffentlichung den aktiven Snapshot, behält aber Entwurf und Freigaben. Das Löschen einer App entfernt ihre Route, nicht die Basisdaten. Beide Aktionen erfordern eine Bestätigung.

Es werden nur die aktive Seite und ihr optionaler Datensatz geladen. Verborgene Detailseiten werden nicht vorgeladen.
