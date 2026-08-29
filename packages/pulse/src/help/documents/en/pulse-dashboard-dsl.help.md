---
id: pulse-dashboard-dsl
title: Dashboard DSL
icon: ti ti-layout-dashboard
description: Controls, sections, rows, cards, widgets, markdown, and conditions.
order: 130
---
Dashboard DSL describes the whole dashboard. Write and preview it as text so layout, queries, notes, and visual warning states stay together in one editable document.

## Build in layers {icon="square-plus"}

:::steps
1. **Start with one section:** Give the dashboard a name and add the smallest section that answers one real question.
2. **Add one widget:** Use stat, gauge, line, bar, histogram, heatmap, map, or table depending on the query output.
3. **Add controls when repetition appears:** Use controls for range, source, entity, entity_type, label, or text values that multiple widgets share.
4. **Group related widgets:** Use rows for side-by-side charts, cards for a related cluster, and sections for larger topics.
5. **Explain decisions in place:** Use descriptions and markdown for operating notes, assumptions, and links.
:::

## Start with the smallest useful dashboard {icon="layout-dashboard"}

**Minimal dashboard**

```text
dashboard "Ops" {
  section "Overview" {
    stat "Requests" {
      query metric http_requests_total rate every 1m since 1h
    }
  }
}
```

This is enough to render useful content: a root document, one section, one widget, and one query. An empty `dashboard "Name" {}` document is valid while creating a dashboard, but it has nothing to display.

## Write exact Dashboard DSL {icon="braces"}

Dashboard statements and visual names are case-sensitive. Use the spelling shown in this reference, including `barGauge`.

Names, descriptions, messages, and other quoted text use double quotes. Inside quoted text, `\n` creates a line break, `\t` creates a tab, and a backslash escapes the following character. Markdown content uses triple double quotes:

```text
description "Line one\nLine two"

markdown "Runbook" {
  """
  ## Recovery

  Follow the service runbook.
  """
}
```

Use `#` or `//` for line comments wherever whitespace is allowed.

## Add controls when values repeat {icon="point"}

**Controls and variables**

```text
dashboard "Ops" {
  controls {
    range "Range" variable range default 24h options 1h, 6h, 24h, 7d
    entity "Container" variable entity_id type container default container:app-core
  }

  section "Container" {
    line "Memory" {
      query metric docker.container.memory.usage avg every 5m since $range entity $entity_id
    }
  }
}
```

Controls create variables such as `$range` or `$entity_id`. If `variable` is omitted, Pulse derives it from the label, for example `Resource type` becomes `$resource_type`. If `default` is omitted, Pulse uses the first option. A range with neither a default nor options uses `24h`; other controls use an empty value.

Public displays use control defaults and do not show interactive controls, so choose defaults that make sense without interaction.

## Full shape {icon="point"}

**Shape**

```text
dashboard "Name" {
  description "Optional context."

  controls {
    range "Range" variable range default 24h options 1h, 6h, 24h, 7d
    source "Source" variable source_id default Src001
    entity "Entity" variable entity_id type container default container:app-core
    label "Region" variable region default eu options eu, us
    text "Search" variable search default ""
  }

  section "Section" {
    row height md {
      line "Chart title" {
        query metric orders.created increase every 1h since $range source $source_id where region=$region
        warn when value > 100
      }
    }

    table "Recent events" {
      query events deploy.finished since $range entity $entity_id limit 50
    }

    table "Current states" {
      query states service.online entity $entity_id limit 50
    }

    map "Recent engagement" {
      description "Approximate places where recent QR links were opened."
      query events qr.opened since $range where campaign=summer limit 500
      latitude attribute geo.latitude
      longitude attribute geo.longitude
      label attribute geo.city
      series dimension campaign
      size count
    }

    markdown "Notes" {
      """
      ## Markdown content
      Add context, links, and operating notes.
      """
    }
  }
}
```

**Example**

```text
dashboard "Solar overview" {
  description "Live power, battery state, and grid interaction."

  section "Today" {
    description "Operational view for the current day."

    card "Battery" {
      description "Shows current charge and recent charge/discharge trend."

      gauge "Charge" {
        description "Latest state of charge reported by the inverter."
        query metric solar.battery.charge_percent latest since 10m
        warn when value < 20 message "Battery is low"
        critical when value < 10 message "Battery is critical"
      }
    }

    markdown "Notes" {
      """
      ## Operating notes

      - Values update every minute.
      - Grid import above 2 kW usually means the battery is empty.
      - Check inverter status if output drops while irradiance is high.
      """
    }
  }
}
```

## Statement reference {icon="book-2"}

| Statement | Scope | Meaning | Example |
| --- | --- | --- | --- |
| `dashboard "Name" { ... }` | root | Defines one dashboard. Edit this document to change its content and layout. | `dashboard "Ops" { stat "Status" { query metric service.online latest since 10m } }` |
| `description "Text"` | dashboard, section, card, widget, markdown | Adds reader-facing context without changing data queries. | `description "Live operational view."` |
| `controls { ... }` | dashboard | Declares reusable variables rendered above the dashboard. | `controls { range "Range" variable range default 24h options 1h, 24h }` |
| `range/source/entity/entity_type/label/text "Label"` | controls | Creates a control. Use variable, default, options, and type where useful. If default is omitted, the first option is used. | `entity "Container" variable entity_id type container default container:app-core` |
| `section "Name" { ... }` | dashboard, section | Groups related rows and nested sections. | `section "Today" { line "Orders" { query metric orders.created increase since 24h } }` |
| `row height sm\|md\|lg { ... }` | dashboard, section, card | Places multiple widgets in one row. If height is omitted, md is used. | `row height lg { line "CPU" { query metric system.cpu.usage avg since 6h } }` |
| `card "Name" [span n] { ... }` | dashboard, section, row | Frames related child widgets and optional markdown. Cards cannot contain nested cards or sections. Span is an optional integer from 1 to 12. | `card "Battery" span 6 { gauge "Charge" { query metric battery.charge latest since 10m } }` |
| `markdown ["Name"] [span n] { """ ... """ }` | dashboard, section, row, card | Adds Markdown notes, explanations, runbooks, or links. Markdown content must be triple-quoted. | `markdown "Notes" { """## Notes\n- Check importer health.""" }` |
| `line/bar/stat/gauge/barGauge/histogram/heatmap/table "Name"` | dashboard, section, row, card | Adds a metric, summarized-event, event-row, or state widget. Metric and summarized-event queries use numeric visuals; event rows use tables; states use tables or stats. | `gauge "Charge" { query metric battery.charge latest since 10m }` |
| `map "Name" [span n] { ... }` | dashboard, section, row, card | Plots event locations. It requires an event rows query plus latitude and longitude selectors. | `map "Scans" { query events qr.opened since 24h latitude attribute geo.latitude longitude attribute geo.longitude }` |
| `latitude\|longitude dimension\|attribute <path>` | map | Selects decimal-degree coordinates from a dimension or attribute. Nested attribute paths use dots. Sensitive fields cannot be selected. | `latitude attribute geo.latitude` |
| `label\|series dimension\|attribute <path>` | map | Optionally adds point labels or separates points into colored series. | `series dimension campaign` |
| `size count\|sum` | map | Sizes points by matching event count or by the sum of numeric event values. Count is the default. | `size count` |
| `visual <type>` | widget | Overrides the visual declared by the outer widget keyword. It accepts the same visual names. Prefer the direct widget keyword for hand-written DSL. | `line "Current value" { visual stat query metric service.online latest since 10m }` |
| `query <Query DSL>` | widget | Uses metric, events, or states Query DSL. Dashboard controls may be referenced as $variables. Summarized events can drive numeric widgets. | `query events order.created count every 1h since $range group by channel` |
| `warn\|critical when value <op> <value>` | metric widget | Applies visual state to metric values only. Operators are >, >=, <, <=, =, and !=. Optional message text can explain the condition. | `critical when value > 95 message "Capacity almost full"` |
| `# comment or // comment` | anywhere whitespace is allowed | Adds a line comment that does not change the rendered dashboard. | `# explain why this section exists` |

## Design rules {icon="book-2"}

:::info Dashboards compose query output
Widget `query` lines use the same Query DSL. Metrics and summarized events show values and charts. Table widgets show individual events and current states. Metric `group by resource` and `group by <dimension>` create separate chart series.
:::

:::info Maps summarize event locations
Use a map for events that contain decimal latitude and longitude fields. Pulse groups matching events by location, optional label, and optional series across the selected range. Invalid or out-of-range coordinates are ignored. A map shows at most 1,000 aggregated points, so use source, entity, and dimension filters when a broad query would hide useful detail. On a public dashboard, the aggregated coordinates, labels, and series shown by the map are public too.
:::

:::info Controls define variables
Declare controls once, then use variables inside widget queries. This keeps dashboards editable without duplicating filters.
:::

:::info Public displays use defaults
Public links render with each control's default value. Keep public dashboards deterministic by choosing useful defaults.
:::

:::info Refresh is a dashboard setting
Auto-refresh is configured outside Dashboard DSL. Choose 1, 5, 10, or 60 seconds, or disable automatic refresh. New dashboards default to five seconds, and editing DSL keeps the existing refresh setting.
:::

:::warning Conditions are visual
Use `warn when value > 80` or `critical when value = false` to mark metric widgets visually. Alert delivery and webhooks are a separate future layer.
:::

## Limits {icon="ruler"}

- Dashboard DSL is limited to 40,000 characters.
- Titles are limited to 160 characters. Dashboard descriptions are limited to 1,000 characters; section, card, widget, and Markdown descriptions to 500.
- One Markdown block is limited to 8,000 characters.
- A dashboard supports up to 24 controls and 24 top-level sections.
- A section supports up to 24 rows and 12 nested sections. Nested sections stop after three child levels.
- A row supports up to 12 cells. `span` must be an integer from 1 to 12.
- One widget supports up to eight visual conditions.
