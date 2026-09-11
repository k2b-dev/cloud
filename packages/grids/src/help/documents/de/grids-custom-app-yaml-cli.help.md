---
id: grids-custom-app-yaml-cli
title: Grids App YAML & CLI
icon: ti ti-terminal-2
description: Kanonische App-Definition validieren, planen, anwenden, exportieren und veröffentlichen.
order: 136
---
Visueller Builder und CLI verwenden dieselbe Definition. YAML verbindet vorhandene Ressourcen und ist kein Deployment-Paket für eine ganze Base. Tabellen, Felder, Ansichten, Formulare, Dokumentvorlagen und Workflow-Launcher zuerst anlegen; anschließend ihre öffentlichen Ressourcen-IDs verwenden.

## Vertrag lesen {icon="book-2"}

Die [Custom-App-API-Referenz](/app/grids/help/grids-custom-app-api) beschreibt sämtliche Optionen, Standardwerte, Bindungen und Payloads. `cld grids apps reference --json` liefert das installierte `definitionSchema`. JSON Schema beschreibt Eingaben; der Server prüft zusätzlich Zugriffe, Typen, Abfragen und Navigation.

Für einen visuellen Einstieg: `cld grids apps create MyBase --name "Requests" --json`, danach `apps export MyBase Requests --out app.yaml`.

## Eine strikte Wurzeldefinition {icon="file-code"}

Beispiel-IDs durch tatsächliche IDs aus der gewählten Base ersetzen:

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

[Seiten und Blöcke](/app/grids/help/grids-custom-app-pages-blocks) erklärt Nutzungsabläufe. Bindungen sind typisierte Objekte, etwa `{ source: ROW, path: relation, fieldId: res301 }` für Navigation über eine ausgewählte Einfachrelation. Unbekannte Schlüssel, doppelte IDs und inkompatible Referenzen scheitern bei der Validierung.

## Validieren, planen und anwenden {icon="list-check"}

```bash
cld grids apps validate MyBase --source-file app.yaml --json
cld grids apps plan MyBase --source-file app.yaml --json
cld grids apps apply MyBase --source-file app.yaml --dry-run --json
cld grids apps apply MyBase --source-file app.yaml --json
```

Validieren schreibt nichts. Plan vergleicht zusätzlich den gespeicherten Entwurf und liefert Änderungen, Diagnosen und abgeleitete Veröffentlichungsberechtigungen. `apply --dry-run` führt denselben Plan aus. Normales Apply erstellt oder aktualisiert die angegebene App-ID; unveränderte kanonische Definitionen bleiben ohne Änderung. Es veröffentlicht nichts. Den verantwortlichen Eingabepfad korrigieren, statt Zielgruppenbeschränkungen abzuschwächen.

## Veröffentlichen und wiederherstellen {icon="rocket"}

```bash
cld grids apps export MyBase Requests --published --out app-live.yaml
cld grids apps publish MyBase Requests --yes --json
cld grids apps restore MyBase Requests --yes --json
cld grids apps unpublish MyBase Requests --yes --json
cld grids apps delete MyBase Requests --yes --json
```

Diese Befehle benötigen Base Admin. Publish kompiliert erneut und ersetzt die Live-Version nur bei Erfolg. Restore ersetzt den Entwurf durch die veröffentlichte Version; Unpublish entfernt die Live-Version; Delete entfernt die App aus normalen Listen und ihre Live-Route, nicht ihre Base-Ressourcen. Vor `--yes` prüfen. Den vollständigen Ablauf mit der vorgesehenen Zielgruppe testen; eine Admin-Vorschau beweist keine Isolation.

Vor Freigaben [Veröffentlichen und Berechtigungen](/app/grids/help/grids-publish-custom-app) lesen. Die CLI-Hilfe erklärt Flags; `apps list|get` zeigt vorhandene Apps.
