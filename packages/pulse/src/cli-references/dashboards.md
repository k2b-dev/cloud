# Dashboards

Save JSON plus SQL as a dashboard in a base you can write. Read access lets
people and agents open it and run its panels. `dashboard.list` and
`dashboard.read` are the corresponding Assistant queries.

## Save a website dashboard

Create `traffic.json`:

```json
{
  "name": "Website",
  "definition": {
    "panels": [
      {
        "id": "visits",
        "title": "Page views",
        "kind": "number",
        "sql": "SELECT count() AS visits FROM events WHERE kind = 'page_view' AND ts >= :from AND ts < :to",
        "columns": ["visits"],
        "width": "third"
      }
    ]
  }
}
```

```sh
cld pulse dashboards save --base <base-id> --file traffic.json --idempotency-key website-v1 --json
cld pulse dashboards list --base <base-id> --json
cld pulse dashboards get <dashboard-id> --base <base-id> --json
cld pulse dashboards panel <dashboard-id> visits --base <base-id> --range 7d --json
```

To update, add `expectedRevision` from `get` to the JSON and pass
`--dashboard <dashboard-id>`. Reuse an idempotency key only for retries of the
same operation; receipts last 24 hours. A revision conflict means reread
before replacing the current dashboard.

Panels can be `number`, `line`, `bar`, `table`, or `funnel`. Set `columns` to
the output names the panel displays. Charts need `x`; `line` uses a DateTime
column, while `bar` and `funnel` use categories. Optional `series` separates
line or bar groups. A number needs one numeric value column. Without `x`, it
accepts at most one aggregate row; with a DateTime `x`, it shows the last
value and up to 480 trend points. Optional String columns `unit`, `detail`,
and `detailTone` provide presentation. A funnel needs one category and one
nonnegative value column. `unit`,
`threshold`, `section`, and `width` (`third`, `half`, `full`) control display.
Panels in a named section share optional `sectionIcon` (for example
`ti ti-router`), `sectionDescription` (source and cadence), and `sectionColor`
(a six-digit hex color). Use identical section presentation on its panels.

There are at most 36 panels, eight series and 480 points per series, and
3,840 marks per panel. Truncated SQL results and excessive output produce a
panel error; Pulse never silently trims them. Aggregate in SQL first.

`:from`, `:to`, and `:bucket` follow the selected range on a shared grid.
Other parameters come from the panel's `params`. The ranges are `24h`, `7d`,
`30d`, `90d`, or a custom `--from` and `--to` pair in RFC 3339 format.
SQL retains the base's read profile and shared admission limits. Panels do
not spend the questions quota. Each panel runs at most once per revision,
range, and 60-second interval across replicas. Errors back off from one to
five minutes; a retry does not bypass that limit. A previous successful
result remains visible with its timestamp when available.

## Publish reviewed output

Anyone with the public link can read every listed output column. Review the
SQL and columns first. Publication includes results and presentation, with no
SQL or parameters in the public document.

```sh
cld pulse dashboards publish <dashboard-id> --base <base-id> \
  --expected-revision 1 --columns '{"visits":["visits"]}' --yes \
  --idempotency-key website-public-v1 --json
cld pulse dashboards unpublish <dashboard-id> --base <base-id> --expected-revision 2 --yes
cld pulse dashboards delete <dashboard-id> --base <base-id> --expected-revision 3 --yes
```

Use the returned `href`. Publishing again rotates the link. SQL, parameters,
selected columns, or output changes end a publication; title and layout edits
retain it. Clearing base data invalidates cached results but preserves the
dashboard definition. Deleting the base removes its dashboards and links.

`dashboard.save` asks for approval, which can be remembered within a base.
An edit that ends a publication asks again. `dashboard.publish`,
`dashboard.unpublish`, and `dashboard.delete` always ask. All four actions
require an idempotency key and the same access as the CLI.
