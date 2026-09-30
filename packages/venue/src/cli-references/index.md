# Venue CLI

## What Venue is

Venue manages staffed places with public opening status, shift signup, public page content, and visitor feedback.

Use `cld venue` to operate venues that the signed-in user can access. Select the venue first when several commands belong to the same venue.

## Select and inspect a venue

```bash
cld venue list --json
cld venue use "Cafe Counter"
cld venue get --json
cld venue status --json
```

Commands accept a six-character venue ID, exact slug, or exact name. Direct resource IDs are always the short IDs shown by `cld venue list`; legacy UUIDs are rejected. A slug is discovery metadata and does not become the stored default or a URL identity. If an ID, slug, and name resolve to different venues, the command stops as ambiguous. The configured default venue stores the short ID and is used when a command allows the venue to be omitted.

Venue, opening-rule, date-override, shift-template, assignment, and public-section IDs follow Cloud's short public-resource convention. A dated shift is a virtual occurrence: identify it by its venue ID, template ID, and date rather than treating its rendered calendar key as a resource ID.
See [Public resource identifiers](/en/docs/data/public-resource-identifiers) for the platform-wide identity contract.

## Opening rules, public sections, and shifts

```bash
cld venue opening-rules list "Cafe Counter" --json
cld venue opening-rules create "Cafe Counter" --weekday 1 --start 11:00 --end 18:00
cld venue sections list "Cafe Counter" --json
cld venue shifts list "Cafe Counter" --json
```

With read permission, `cld venue get` returns `"feedback": null` and no feedback entries, and `cld venue sections list` lists only the sections the public page shows. Staff (`write`) and admin see visitor feedback and drafts. The `visibility` column says `public` or `draft`; a draft (`"enabled": false` in JSON) is not on the public page.

Creating a public section requires a section kind, title, and JSON content. Read `cld venue sections create --help` first, then pass multiline JSON with `--content-file` or `--stdin`. A links section takes `{"links": [{"label": "…", "href": "…"}]}`; every `href` must be an `https:`, `http:`, `mailto:`, or `tel:` address or a path on the same Cloud starting with `/`, or the command fails with 400. `cld venue sections update` changes only the flags you pass: a draft stays a draft and every section keeps its position unless you pass `--enabled`, `--disabled`, or `--position`.

```bash
cld venue sections update "Cafe Counter" <section-id> --title "Winter hours"
cld venue sections update "Cafe Counter" <section-id> --enabled
```

Inspect shift assignments before cancelling one; `cld venue shifts cancel <venue> <assignment-id> --yes` is destructive. Read and staff users cancel only their own assignments; admins can also remove other people from a shift, as in the workspace.

## Venue access and API keys

```bash
cld venue access list "Cafe Counter" --json
cld venue access grant "Cafe Counter" --group "Staff" --permission write
cld venue access grant "Cafe Counter" --service-account "Release agent" --permission read
cld venue api-keys list "Cafe Counter" --json
cld venue api-keys create "Cafe Counter" --name "Display" --permission read
```

Store a newly printed venue API key immediately because its secret is shown once. Use `access set` for an idempotent direct grant. `--service-account` takes a service account ID or exact name; `search-principals --kind service_account` finds standalone and agent accounts by name. `access list` shows agent grants; `--include-service-accounts` also shows the grants behind venue API keys.

An agent account works like a person with the same grant: it lists the venues it was granted and reads their dashboards. Its token's scopes cap the grant, so changing a venue's settings, hours, templates, sections, or access needs an `admin` grant and a token with the `admin` scope. Creating venues, managing API keys, and signing up for or cancelling shifts stay limited to people. Read the matching revoke or delete command help before removing a key, a section, an opening rule, a shift assignment, or an entire venue.

## Complete command catalogue

Run `cld venue <command> --help` for flags and argument order.

| Area | Commands |
| --- | --- |
| Venue | `list`, `use`, `get`, `status`, `create`, `update`, `delete` |
| API keys | `api-keys list`, `api-keys create`, `api-keys revoke` |
| Opening rules | `opening-rules list`, `opening-rules create`, `opening-rules delete` |
| Public sections | `sections list`, `sections create`, `sections update`, `sections delete` |
| Shifts | `shifts list`, `shifts cancel` |
| Access | `access list`, `access grant`, `access set`, `access revoke`, `access search-principals` |
