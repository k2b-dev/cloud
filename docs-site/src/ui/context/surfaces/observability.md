# Observability Surfaces

The observability components give admin and operations pages a shared structure: `PanelHeader` names a panel, `DataPanel` frames records, `StatusBadge` states health, `NoticeCard` keeps findings visible, and `RangePicker` selects a URL-backed time window.

The application owns queries, filters, domain wording, and recovery actions.

## Use observability surfaces

Use these components together when an operations page needs to answer:

1. What scope is shown?
2. Is the system healthy?
3. What needs attention?
4. Which records explain the summary?
5. Which time window produced the result?

Do not use a toast for a finding that must remain visible. Do not use an empty state for data that failed to load.

## Import

```tsx
import {
  DataPanel,
  DataTable,
  NoticeCard,
  PanelHeader,
  RangePicker,
  StatusBadge,
} from "@k2b/ui";
```

## Properties

### PanelHeader

`PanelHeader` renders a title, optional subtitle, and trailing actions. The parent owns the surface, border, padding, and spacing.

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `title` | `JSX.Element` | required | Names the panel. |
| `subtitle` | `JSX.Element` | none | States a count, scope, or current view. |
| `actions` | `JSX.Element` | none | Adds compact trailing controls. |
| `as` | `"h1" \| "h2" \| "h3"` | `"h2"` | Preserves heading hierarchy. |
| `size` | `"sm" \| "md" \| "lg"` | `"sm"` | Selects panel, section, or page-level type scale. `"lg"` is the page title of an overview. |

`DataPanel` already includes `PanelHeader`.

### DataPanel

`DataPanel` frames a list or table. It accepts slots for search, filters, actions, rows, and a footer.

Set `error` when the query failed. It takes precedence over `isEmpty`. Set `isEmpty` only after the query succeeded with no rows.

| Property | Purpose |
| --- | --- |
| `title`, `subtitle`, `actions` | Describe the panel and its scope. |
| `search`, `filters` | Insert application-owned controls. |
| `children` | Render the list or table. |
| `error` | Replace the body with a failed-load state. |
| `isEmpty`, `empty` | Replace the body after a successful empty result. |
| `footer` | Add pagination or other controls below the rows. |
| `as` | Use `"h1"` only when the panel is the primary page content. |

Search remains a slot because client islands must stay in the consuming application.

### Findings and status

Use [StatusBadge](/en/ui/feedback/badges) for one labeled health state and
[NoticeCard](/en/ui/feedback/blocks) for a persistent finding. Choose tones by
meaning; keep domain-specific wording in their visible labels. `NoticeCard.Grid`
arranges several findings and renders nothing for an empty list.

### RangePicker

`RangePicker` renders ordinary links because the selected window belongs in the URL and affects server queries.

| Property | Purpose |
| --- | --- |
| `options` | Supplies `{ value, label?, href }` for every available window. |
| `value` | Marks the current option with `aria-current`. |
| `label` | Adds a visible caption. Pass `null` to omit it. |
| `ariaLabel` | Names the navigation when no visible label is present. |

Build every `href` from the current filter state so changing the range does not discard unrelated filters.

## API reference

```ts
type PanelHeaderProps = {
  title: JSX.Element; subtitle?: JSX.Element; actions?: JSX.Element; as?: "h1" | "h2" | "h3";
  size?: "sm" | "md" | "lg"; class?: string;
};

type DataPanelProps = {
  title: JSX.Element; subtitle?: JSX.Element; actions?: JSX.Element; search?: JSX.Element;
  filters?: JSX.Element; children?: JSX.Element; error?: string | null; empty?: JSX.Element;
  isEmpty?: boolean; footer?: JSX.Element; as?: "h1" | "h2"; class?: string;
};

type RangeOption<T extends string> = {
  value: T; label?: string; href: string;
};

type RangePickerProps<T extends string> = {
  options: readonly RangeOption<T>[]; value: T; label?: string | null; ariaLabel?: string; class?: string;
};
```

StatusBadge and NoticeCard have their canonical contracts on [Status badges](/en/ui/feedback/badges) and [Notices](/en/ui/feedback/blocks). `RangePicker` uses direct values and ordinary anchors; option `label` falls back to `value`. `label={null}` omits its visible caption.

## Accessibility

Choose heading levels from the page hierarchy. Every status needs a visible label; tone and icons are supplementary.

Name a label-free `RangePicker` with `ariaLabel`. Keep diagnostic titles specific enough to scan without their detail. Search and filter slots retain responsibility for their own labels and keyboard behavior.

## Runtime

All five components render on the server. `RangePicker` works without hydration. Interactive search or filter controls passed into `DataPanel` belong to the consuming island.

## Example

```tsx
<NoticeCard.Grid items={findings}>
  {(finding) => (
    <NoticeCard
      tone={finding.tone}
      title={finding.title}
      detail={finding.detail}
    />
  )}
</NoticeCard.Grid>

<div class="app-badge-row">
  <StatusBadge tone="ok" label="Online" />
  <StatusBadge tone="warning" label="Overdue" />
  <StatusBadge tone="error" label="Failed" />
  <StatusBadge
    tone="degraded"
    label="Diagnostics unavailable"
    title="Postgres diagnostics unavailable"
  />
  <StatusBadge tone="running" label="Refreshing" variant="dot" />
  <StatusBadge tone="neutral" label="Disabled" variant="text" />
</div>

<DataPanel
  title="Routes"
  subtitle={`${rows.length} of ${total} routes`}
  actions={
    <RangePicker
      label={null}
      ariaLabel="Request window"
      value={range}
      options={ranges.map((value) => ({
        value,
        href: buildUrl(filters, { range: value }),
      }))}
    />
  }
  error={loadError}
  isEmpty={rows.length === 0}
  empty="No route produced traffic in this window."
>
  <DataTable
    rows={rows}
    columns={columns}
    renderCell={({ row, col, render, value }) =>
      col.id === "state"
        ? <StatusBadge tone={row.state} label={row.stateLabel} />
        : render(value)
    }
  />
</DataPanel>
```
