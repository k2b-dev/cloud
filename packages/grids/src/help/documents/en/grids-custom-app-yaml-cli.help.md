---
id: grids-custom-app-yaml-cli
title: Grids App YAML & CLI
icon: ti ti-terminal-2
description: Validate, plan, apply, export, and publish the canonical app definition.
order: 136
---
The visual builder and CLI share one definition. YAML composes existing resources; it is not a whole-Base deployment bundle. Create tables, fields, Views, Forms, Documents and Workflow launchers first, then use their canonical public resource IDs.

## Read the contract {icon="book-2"}

Read the [Custom App API reference](/app/grids/help/grids-custom-app-api) for every option, default, binding and payload. Fetch `cld grids apps reference --json` for the installed `definitionSchema`. JSON Schema describes input; the server compiler additionally verifies resource access, types, queries and navigation.

For a visual start, run `cld grids apps create MyBase --name "Requests" --json`, then `apps export MyBase Requests --out app.yaml`.

## Use one strict root document {icon="file-code"}

Replace these illustrative resource IDs with IDs from the selected Base:

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

See [Pages and blocks](/app/grids/help/grids-custom-app-pages-blocks) for audience journeys. Bindings are typed objects, for example `{ source: ROW, path: relation, fieldId: res301 }` for navigation through a selected single relation. Unknown keys, duplicate IDs and incompatible references fail validation.

## Validate, plan and apply {icon="list-check"}

```bash
cld grids apps validate MyBase --source-file app.yaml --json
cld grids apps plan MyBase --source-file app.yaml --json
cld grids apps apply MyBase --source-file app.yaml --dry-run --json
cld grids apps apply MyBase --source-file app.yaml --json
```

Validate checks without writing. Plan also compares the saved draft and returns changes, diagnostics and derived publication capabilities. `apply --dry-run` performs that same plan. Ordinary apply creates or updates the supplied App ID; applying an unchanged canonical definition is a no-op. It never publishes. Read diagnostic paths and fix their owning input rather than weakening audience restrictions.

## Publish and recover {icon="rocket"}

```bash
cld grids apps export MyBase Requests --published --out app-live.yaml
cld grids apps publish MyBase Requests --yes --json
cld grids apps restore MyBase Requests --yes --json
cld grids apps unpublish MyBase Requests --yes --json
cld grids apps delete MyBase Requests --yes --json
```

These commands require Base Admin. Publish recompiles and replaces the live snapshot only on success. Restore replaces the draft with the published version; unpublish removes the live version; delete removes the App from normal listings and its live route, not its Base resources. Review before using `--yes`. Check the complete journey with the intended audience before publishing; an admin preview does not prove isolation.

Read [Publish and permissions](/app/grids/help/grids-publish-custom-app) before granting access. CLI command help documents flags; `apps list|get` inspect existing Apps.
