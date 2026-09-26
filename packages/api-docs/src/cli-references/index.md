# API Docs CLI

## What API Docs is

API Docs is the live HTTP API catalogue of a Cloud instance. Cloud apps publish OpenAPI documents through the app registry, and `cld api-docs` makes those documents searchable and readable from the terminal.

Use it when an integration, website, script, or coding agent needs to call a Cloud app through HTTP. `cld apps list` answers which user-facing apps are available; `cld api-docs list` answers which running apps and platform services publish an OpenAPI document.

## Discover documented APIs

```bash
cld api-docs list
cld api-docs list --search grids --json
```

`list` returns the app id, name, description, and live OpenAPI URL.

| Flag | Meaning |
| --- | --- |
| `--search <text>` | Filter by app id, name, or description. |

## List operations

```bash
cld api-docs operations grids
cld api-docs operations grids --method POST
cld api-docs operations grids --tag "Grids:Record" --json
```

The app argument accepts an app id or exact app name. Paths include the OpenAPI server base, so a raw `/records` path may be displayed as `/api/grids/records`.

| Flag | Meaning |
| --- | --- |
| `--method <method>` | Filter by HTTP method. Method matching is case-insensitive. |
| `--tag <tag>` | Filter by one exact OpenAPI tag, case-insensitively. |

## Search operations

```bash
cld api-docs search "create record"
cld api-docs search "optimistic lock" --app grids --json
cld api-docs search "attachment" --method POST --limit 20
```

Search covers operation ids, summaries, descriptions, methods, paths, tags, and operation schemas. By default it searches every published source and returns up to 50 matches. A temporarily unavailable source is reported as a warning while results from healthy sources remain available.

| Flag | Meaning |
| --- | --- |
| `--app <app>` | Search only one app id or exact app name. |
| `--method <method>` | Filter by HTTP method. |
| `--tag <tag>` | Filter by one exact OpenAPI tag. |
| `--limit <count>` | Return at most 1-500 matches; default 50. |

## Inspect one operation

```bash
cld api-docs show grids POST /api/grids/records/by-table/{tableId}
cld api-docs show grids GET /records/{id} --json
```

`show` accepts either the raw OpenAPI path or the effective path including the server base. Text output includes the operation id, tags, declared security, parameters, request-body schemas, and responses. Use `--json` for the exact structured operation metadata and original OpenAPI operation object.

Security output has three states:

- `required` means the OpenAPI document declares one or more security schemes.
- `public` means the operation explicitly declares an empty security requirement.
- `not declared` means the document does not say. Do not infer that the endpoint is public.

## Read the raw OpenAPI document

```bash
cld api-docs spec grids > grids.openapi.json
```

`spec` writes the unmodified upstream OpenAPI JSON to stdout. Use it when the compact operation views do not expose a field needed by a generator or integration tool.

## Output modes

- Use normal text for quick inspection.
- Use `--json` for structured list, operation, and search results.
- Use `--jsonl` to stream one source or operation per line from list-style commands.
- `spec` always emits raw OpenAPI JSON so it can be redirected directly to a file or another process.
