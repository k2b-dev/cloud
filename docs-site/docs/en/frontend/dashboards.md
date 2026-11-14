---
title: Dashboards from descriptions
navTitle: Dashboards
section: Frontend
order: 827
description: Draw charts, key figures, tables and record details from portable descriptions in one dashboard frame, with every state in place.
tags: [dashboard, chart, key figures, table, details, description, states]
updated: 2026-11-07
---

# Dashboards from descriptions

A dashboard page shows data panels: charts, key figures, tables, record
details, and money blocks. Draw each panel from its portable description with
`DescriptionPanel` from `@k2b/cloud/descriptions`. Chat, the chart showcase,
and Code pages draw descriptions the same way, so a panel looks and behaves
the same in every app.

The layout comes from `@k2b/ui`: `DashboardGrid` measures the dashboard,
`DashboardSection` groups panels under a title, and every panel takes a
`width` of `third`, `half`, `twoThirds`, or `full`. See
[Dashboard frame](/en/ui/widgets/composition#dashboard-frame) for the frame and the grid
widths.

## Draw a panel

Pass the description, a fallback title, the panel's width and its content
height:

```tsx
import { DescriptionPanel } from "@k2b/cloud/descriptions";
import { DashboardGrid, DashboardSection } from "@k2b/ui";

<DashboardGrid>
  <DashboardSection title="October" icon="ti ti-calendar-month">
    <DescriptionPanel
      spec={{ kind: "bar", title: "Out by category", data: categories }}
      title="Out by category"
      width="third"
      height={280}
      empty="Nothing went out in October."
    />
    <DescriptionPanel
      spec={{ block: "details", title: "Invoice 2026-118", items: fields }}
      title="Invoice"
      width="third"
      height={200}
    />
  </DashboardSection>
</DashboardGrid>;
```

A chart `{ kind, … }` draws with its title, subtitle, Copy data, the
Diagram and Table switch, and its legend. `{ block: "stats" }` draws one row
of key-figure tiles. `{ block: "table" }` draws a typed table with search and
grouping in the panel's head. `{ block: "details" }` draws the fields of one
record in the same form as Chat's details view. `budget`, `balance` and
`flow` draw their money components.

## Show the state of the read

Every panel takes the same states, in the same place and at the same height:

- `state` is `ready` (default), `loading`, `empty`, `error`, or `stale`;
- `asOf` is the time of the shown data, already formatted, such as "09:12".
  A stale panel names it in its subtitle line;
- `onRetry` adds Try again to a failure and a stale note;
- `empty` is the sentence of an empty panel, such as "No campaign in this
  period."

A page that has no values for a chart sends the chart's empty form,
`{ kind, title, subtitle?, empty? }` with no other field. Every other chart
description needs at least one value. The panel then shows the chart's frame
with its empty sentence.

The panel's own words, such as the search label and "Nothing to show for
this period.", follow the inherited `@k2b/ui` locale.

## Show what cannot be drawn

A description that this build cannot draw keeps its frame and height and
shows "This view cannot be shown here." Pass `slot` to show your own notice
instead.
