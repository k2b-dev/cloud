---
id: grids-custom-app-yaml-cli
title: Grids App YAML & CLI
icon: ti ti-terminal-2
description: Validate, plan, apply, export, and publish the canonical app definition.
order: 136
---
The visual builder and the CLI share one definition. YAML combines existing resources. It is not a deployment bundle for a whole Base. First create the tables, fields, views, forms, documents, and workflow launchers. Then use their canonical public resource IDs.

## Read the contract {icon="book-2"}

The [Custom App API reference](/app/grids/help/grids-custom-app-api) lists every option, default, binding, and payload. Run `cld grids apps reference --json` to get the installed `definitionSchema`. JSON Schema describes the input. The server compiler also checks resource access, types, queries, and navigation.

To start visually, run `cld grids apps create MyBase --name "Requests" --json`. Then run `apps export MyBase Requests --out app.yaml`.

## Use one strict root document {icon="file-code"}

Replace these example resource IDs with IDs from the selected Base:

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

[Grids App pages & blocks](/app/grids/help/grids-custom-app-pages-blocks) describes journeys for each audience. Bindings are typed objects. For example, `{ source: ROW, path: relation, fieldId: res301 }` navigates through a selected single relation. Unknown keys, duplicate IDs, and incompatible references fail validation.

## Validate, plan, and apply {icon="list-check"}

```bash
cld grids apps validate MyBase --source-file app.yaml --json
cld grids apps plan MyBase --source-file app.yaml --json
cld grids apps apply MyBase --source-file app.yaml --dry-run --json
cld grids apps apply MyBase --source-file app.yaml --json
```

:::reference
- **validate:** Checks the definition and writes nothing.
- **plan:** Also compares the saved draft. It returns changes, diagnostics, and the derived publication capabilities.
- **apply --dry-run:** Runs the same plan.
- **apply:** Creates or updates the given app ID. An unchanged canonical definition changes nothing. Apply never publishes.
:::

Each diagnostic names a path. Fix the input that owns the path. Do not weaken audience restrictions to pass validation.

## Publish and recover {icon="rocket"}

You need **Manage** access to the Base for these commands:

```bash
cld grids apps export MyBase Requests --published --out app-live.yaml
cld grids apps publish MyBase Requests --yes --json
cld grids apps restore MyBase Requests --yes --json
cld grids apps unpublish MyBase Requests --yes --json
cld grids apps delete MyBase Requests --yes --json
```

:::reference
- **publish:** Compiles again. Replaces the live snapshot only on success.
- **restore:** Replaces the draft with the published version.
- **unpublish:** Removes the live version.
- **delete:** Removes the app from normal lists and removes its live route. Its Base resources stay.
:::

:::warning Test with the real audience
Review each command before you add `--yes`. Before you publish, check the complete journey with the intended audience. A preview by a person with **Manage** access does not prove isolation.
:::

Read [Publish a Grids App](/app/grids/help/grids-publish-custom-app) before you give access. The CLI command help lists the flags. `apps list|get` shows existing apps.
