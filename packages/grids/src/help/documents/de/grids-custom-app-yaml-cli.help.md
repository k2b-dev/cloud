---
id: grids-custom-app-yaml-cli
title: Grids App YAML & CLI
icon: ti ti-terminal-2
description: Validiere, plane, wende an, exportiere und veröffentliche die kanonische App-Definition.
order: 136
---
Visueller Builder und CLI verwenden dieselbe Definition. YAML verbindet vorhandene Ressourcen. Es ist kein Deployment-Paket für eine ganze Base. Lege zuerst Tabellen, Felder, Ansichten, Formulare, Dokumentvorlagen und Workflow-Launcher an. Verwende danach ihre kanonischen öffentlichen Ressourcen-IDs.

## Den Vertrag lesen {icon="book-2"}

Die [Custom-App-API-Referenz](/app/grids/help/grids-custom-app-api) beschreibt alle Optionen, Standardwerte, Bindungen und Payloads. Führe `cld grids apps reference --json` aus, um das installierte `definitionSchema` zu erhalten. JSON Schema beschreibt die Eingabe. Der Server-Compiler prüft zusätzlich Ressourcenzugriff, Typen, Abfragen und Navigation.

Für einen visuellen Einstieg führe `cld grids apps create MyBase --name "Requests" --json` aus. Führe danach `apps export MyBase Requests --out app.yaml` aus.

## Ein striktes Wurzeldokument verwenden {icon="file-code"}

Ersetze diese Beispiel-IDs durch IDs aus der gewählten Base:

```yaml
schemaVersion: 5
kind: grids.custom-app
id: app001
baseId: bas001
name: Requests
startPageId: home
pages:
  - id: home
    title: Home
    rows:
      - id: content
        columns:
          - id: main
            span: 12
            blocks:
              - id: intro
                type: markdown
                markdown: "# Requests"
```

[Seiten und Blöcke in Grids Apps](/app/grids/help/grids-custom-app-pages-blocks) beschreibt die Abläufe für jede Zielgruppe. Bindungen sind typisierte Objekte. So navigiert etwa `{ source: ROW, path: relation, fieldId: res301 }` über eine ausgewählte Einfachrelation. Unbekannte Schlüssel, doppelte IDs und inkompatible Referenzen scheitern bei der Validierung.

## Validieren, planen und anwenden {icon="list-check"}

```bash
cld grids apps validate MyBase --source-file app.yaml --json
cld grids apps plan MyBase --source-file app.yaml --json
cld grids apps apply MyBase --source-file app.yaml --dry-run --json
cld grids apps apply MyBase --source-file app.yaml --json
```

:::reference
- **validate:** Prüft die Definition und schreibt nichts.
- **plan:** Vergleicht zusätzlich den gespeicherten Entwurf. Liefert Änderungen, Diagnosen und die abgeleiteten Capabilities der Veröffentlichung.
- **apply --dry-run:** Führt denselben Plan aus.
- **apply:** Erstellt oder aktualisiert die angegebene App-ID. Eine unveränderte kanonische Definition ändert nichts. Apply veröffentlicht nie.
:::

Jede Diagnose nennt einen Pfad. Korrigiere die Eingabe, zu der der Pfad gehört. Schwäche keine Beschränkungen der Zielgruppe ab, nur damit die Validierung durchläuft.

## Veröffentlichen und wiederherstellen {icon="rocket"}

Für diese Befehle brauchst du Zugriff **Verwalten** auf die Base:

```bash
cld grids apps export MyBase Requests --published --out app-live.yaml
cld grids apps publish MyBase Requests --yes --json
cld grids apps restore MyBase Requests --yes --json
cld grids apps unpublish MyBase Requests --yes --json
cld grids apps delete MyBase Requests --yes --json
```

:::reference
- **publish:** Kompiliert erneut. Ersetzt den veröffentlichten Snapshot nur bei Erfolg.
- **restore:** Ersetzt den Entwurf durch die veröffentlichte Version.
- **unpublish:** Entfernt die veröffentlichte Version.
- **delete:** Entfernt die App aus normalen Listen und entfernt ihre veröffentlichte Route. Ihre Ressourcen in der Base bleiben erhalten.
:::

:::warning Mit der echten Zielgruppe testen
Prüfe jeden Befehl, bevor du `--yes` ergänzt. Teste vor dem Veröffentlichen den vollständigen Ablauf mit der vorgesehenen Zielgruppe. Eine Vorschau durch eine Person mit Zugriff **Verwalten** beweist keine Isolation.
:::

Lies [Grids App veröffentlichen](/app/grids/help/grids-publish-custom-app), bevor du Zugriff gibst. Die Hilfe der CLI-Befehle beschreibt die Flags. `apps list|get` zeigt vorhandene Apps.
