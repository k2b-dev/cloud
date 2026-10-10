---
id: grids-custom-apps
title: Grids Apps
icon: ti ti-app-window
description: Finde die passende Anleitung, um eine Grids App zu erstellen, zu veröffentlichen oder zu verwenden.
order: 137
---
Eine Grids App bietet angemeldeten oder öffentlichen Zielgruppen eine gezielte App unter `/apps/<id>`. Sie öffnet nicht den vollständigen Grids-Arbeitsbereich. Jede App gehört zu einer Base und verwendet vorhandene Datensätze, Ansichten, Formulare, Dokumente und Workflow-Aktionen.

Apps kopieren keine Daten. Eine Veröffentlichung schreibt die Definition und die Ressourcen fest, die die App verwenden darf. Jede Anfrage prüft den aktuellen Zugriff auf die App und die veröffentlichte Capability. Personen, die eine App verwenden, brauchen keinen Zugriff auf die Base. Zugriff auf eine App erlaubt nie beliebiges GQL oder direkten Zugriff auf die Base.

## Den nächsten Schritt wählen {icon="arrow-right"}

- [Eine Grids App erstellen](/app/grids/help/grids-build-custom-app): Erstelle im visuellen Builder eine Liste, einen Formularablauf und eine Detailseite für Datensätze.
- [Seiten und Blöcke](/app/grids/help/grids-custom-app-pages-blocks): Wähle Blöcke, verknüpfe Datensatzparameter und konfiguriere bearbeitbare Felder, Dokumente und Aktionen.
- [YAML und CLI](/app/grids/help/grids-custom-app-yaml-cli): Folge dem vollständigen Definitionsbeispiel. Validiere, plane, wende an und exportiere es.
- [Eine Grids App veröffentlichen](/app/grids/help/grids-publish-custom-app): Prüfe den Zugriff, veröffentliche einen Entwurf, stelle die veröffentlichte Version wieder her oder hebe die Veröffentlichung auf.

Zum Erstellen und Veröffentlichen einer App brauchst du Zugriff **Verwalten** auf die Base. Personen, die die App verwenden, sehen nur, was die Veröffentlichung bereitstellt. Öffentlicher Zugriff schließt anonyme Besucher ein. Workflow-Aktionen erfordern trotzdem ein angemeldetes Konto.

## Eine App im Terminal verwenden {icon="terminal-2"}

Führe `cld grids apps runtime read <app-id> --json` mit der ID aus der App-URL aus. Das Ergebnis enthält sichtbare Seiten, Block-IDs, Daten, Formularfelder und verfügbare Aktionen. Du brauchst keinen Zugriff auf die Base. Um eine Detailseite zu öffnen, ergänze `--page <page-id> --params '{"request_id":"REC001"}'`. Verwende den Parameternamen und die Datensatz-ID aus der zurückgegebenen Navigation.

Mit den Befehlen unter `apps runtime` kannst du:

- Datensätze seitenweise lesen;
- Formulare einer Seite oder der Seitenleiste senden;
- veröffentlichte bearbeitbare Felder ändern;
- Kommentare auflisten, erstellen, ändern und löschen;
- Anhänge auflisten, hochladen, ersetzen, herunterladen und löschen;
- gespeicherte PDFs herunterladen;
- Aktionen oder Scanner starten und ihren Laufstatus lesen.

Führe einen Befehl mit `--help` aus, um seine Eingaben zu sehen. Befehle für eine Seite brauchen dieselben Parameter wie der Discovery-Befehl.

:::warning Ohne Duplikate wiederholen
Senden, Ändern, Scannen und Aktionen erfordern `--yes`. Wiederhole ein Formular nur mit exakt demselben Body und seinem expliziten `idempotencyKey`. Ein Erstellen ohne Schlüssel kann doppelt laufen. Verwende die Operations-ID einer Aktion nur erneut, um genau diesen Vorgang zu wiederholen. **Queued** bedeutet angenommen, nicht abgeschlossen: Prüfe den Lauf, bevor du ihn wiederholst.
:::

Diese Befehle verwenden denselben veröffentlichten App-Zugriff wie der Browser. Sie umgehen keine nicht verfügbaren Blöcke. Ein Detaildatensatz, der fehlt, gelöscht, ungültig, nicht verfügbar oder nicht erlaubt ist, liefert einen Nicht-gefunden-Fehler.

## Entwurf und Veröffentlichung getrennt halten {icon="versions"}

Der Builder speichert vollständige Änderungen automatisch im Entwurf. Bearbeiten ändert die veröffentlichte App nicht. **Änderungen veröffentlichen** validiert und veröffentlicht den gespeicherten Entwurf. Meldet er Diagnosen, behebe sie vor dem nächsten Versuch.

Der Builder bietet **Änderungen veröffentlichen** auch an, wenn eine Änderung an einem Formular, einer Ansicht, einem Feld, einer Vorlage oder einem Workflow ändert, was die veröffentlichte App lesen, schreiben oder starten darf. Hat der Entwurf keine weiteren Änderungen, lautet der Hinweis **Verwendete Ressourcen wurden geändert**.

**Veröffentlichte Version wiederherstellen** verwirft ausstehende Änderungen am Entwurf. Unter **App-Einstellungen → Lebenszyklus** kannst du die Veröffentlichung aufheben oder die App löschen. Beide Aktionen erfordern eine Bestätigung:

- Das Aufheben der Veröffentlichung entfernt den veröffentlichten Snapshot, behält aber Entwurf und Zugriffseinträge.
- Das Löschen einer App entfernt ihre Route. Daten der Base bleiben erhalten.

Eine App lädt nur die aktive Seite und ihren optionalen Datensatz. Verborgene Detailseiten lädt sie nicht im Voraus.
