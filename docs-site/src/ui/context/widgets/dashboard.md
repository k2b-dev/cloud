# Widget composition

The widget family composes compact dashboard blocks from semantic presentation
data. It does not fetch endpoints or depend on a dashboard registry.
`DashboardGrid`, `DashboardSection`, and `DashboardPanel` lay out a whole
dashboard of framed panels on six columns.

## Use Widget composition

Use `Widget` as the standard frame and add only the blocks the summary needs:

- `WidgetStat` for one labeled value;
- `WidgetList` for short linked or static rows;
- `WidgetStatus` for health or state;
- `WidgetPills` for compact labeled values;
- `WidgetHero` for one centered all-clear or spotlight message.

The host owns data loading, permissions, refresh behavior, navigation, and
placement. `Widget` is the only frame; use `size="content"` when the host owns
the height and omit `href` when the header is not a destination. A host that
fills widgets after the page renders, such as a dashboard, renders the loading
and failure states in the same fixed frame size so nothing moves when data
arrives.

The header icon sits in a soft chip of its color, using the host's
`--k2b-app-workspace-active` accent hook.

## Dashboard grid

Use the dashboard grid for a page of panels, such as a Pulse dashboard or a
page of figures in an app:

- `DashboardGrid` is the measuring container. Panel widths follow its own
  width, so a dashboard in a side panel folds like one in a narrow window.
- `DashboardSection` is one titled group of panels. It shows an optional plain
  icon, the title, and a quiet description next to it, which wraps under the
  title when space runs out. Without `title`, pass `ariaLabel` to name it.
- `DashboardPanel` is one framed cell: a light 1 px frame with a 12 px radius
  and 14 px by 16 px padding. Panels in one row share the height of the
  tallest. The panel is the only frame: its content, such as a table, adds no
  second frame and runs to the edges where it needs to.

`width` is the panel's share of six columns:

| `width` | Wide | 1000 px or less | 600 px or less |
| --- | --- | --- | --- |
| `third` (default) | 2 | 3 | 6 |
| `half` | 3 | 3 | 6 |
| `twoThirds` | 4 | 6 | 6 |
| `full` | 6 | 6 | 6 |

The widths in the table are the dashboard's own width, not the window's.
Panels keep their source order: the grid never reorders or packs them, so the
reading order and the keyboard order are the same as on the screen.

A `StatGrid` inside a section is its row of key figures. It always spans all
six columns, keeps four tiles to a row and two at 600 px or less, and stands in
the section where you place it, usually first.

```tsx
<DashboardGrid>
  <DashboardSection title="Impact" icon="ti ti-chart-dots" description="Recipients · one dot is 5 %">
    <StatGrid columns={4}>
      <StatCell label="Subscribers" value={48210} />
      <StatCell label="Open rate" value="49.2 %" />
    </StatGrid>
    <DashboardPanel width="twoThirds" aria-label="Opens and clicks">…</DashboardPanel>
    <DashboardPanel aria-label="Revenue">…</DashboardPanel>
  </DashboardSection>
</DashboardGrid>
```

`DashboardSection` also takes `iconColor`, which tints the glyph and stays
readable in light and dark, and `headingLevel` (2 by default). `DashboardPanel`
renders an `article` by default; set `as` to `section`, `div`, or `li`. It
passes other attributes, such as `aria-label` or `data-*`, to that element.
The host still owns loading, failure, and the content height of each panel.

## Import

```tsx
import {
  DashboardGrid,
  DashboardPanel,
  DashboardSection,
  Widget,
  WidgetHero,
  WidgetList,
  WidgetPills,
  WidgetStat,
  WidgetStatus,
} from "@k2b/ui";
```

## Properties

### Frames

`Widget` requires `title` and `children`. Optional `icon`, `meta`, and `href`
build its compact header. `size` is `"content"`, `"compact"`, `"standard"`, or
`"fill"`; the default standard frame is 25rem high, compact is 14rem, fill takes
the height and the width its container gives it, such as a cell of a dashboard
grid, and does not size itself from its content, and content has no fixed height. Compact fits a header with meta above one stat, status, or hero
and a row of pills. The header has the same height with and without meta. The
body owns the spacing: 0.5rem above, between, and 0.75rem below its blocks,
which have no vertical padding of their own, and every line height is a whole
number of pixels. A fill frame narrower than 15rem sets a hero and a status
more densely; only a fill frame measures its width this way, so other frames
keep the width of their content. A list gives up height down to one row with a
subline and scrolls its own rows, with its scrollbar place reserved, so the
blocks around it stay whole. A fixed frame scrolls other
body content taller than itself instead of cutting it off; it does not contain
overscroll, so a wheel or swipe over a widget whose content fits still scrolls
the page. When `href` is set,
only the header becomes a link, so links inside the body remain valid.

### Content blocks

| Component | Required data | Optional data |
| --- | --- | --- |
| `WidgetHero` | `title` | `subtitle`, `icon`, `tone` |
| `WidgetList` | `items` | `emptyMessage`, `grow` |
| `WidgetPills` | `pills` | `grow` |
| `WidgetStat` | `value`, `label` | `sub`, `valueClass`, `accent`, `grow` |
| `WidgetStatus` | `tone`, `title` | `message`, `icon`, `grow` |

The shared presentation tone for hero icons, list icons, pills, and stat
accents is `"emerald"`, `"amber"`, `"red"`, `"blue"`, or `"zinc"`.

Each `WidgetList` item accepts `label`, optional `sub`, `meta`, `icon`,
`iconTone`, and `href`. Each pill accepts `label`, `value`, optional `tone`,
and `href`. A stat accent accepts `tone`, `icon`, and optional `text`.

`WidgetStatus` uses the shared semantic subset `"success"`, `"warning"`,
`"danger"`, and `"info"`, with a default icon for every tone.

## Composition

Pass presentation values instead of an application response object. `grow`
lets a stat, list, status, or pills block fill the remaining widget height.

Use `href` only for meaningful destinations. Widget headers, list rows, and
pills are native links and remain independently focusable. Without `href`, the
widget header stays plain text and navigation belongs in its content.

## Accessibility

Every stat needs a visible label and enough context to interpret its value.
Write titles and labels in sentence case. The component shows them as written
and never changes their case, so long compound words do not grow wider.
Status blocks include visible text; tone and icons are supplementary.

Long titles and list labels truncate visually but remain complete in the DOM.
Use wording that still identifies the destination when read as a link.
Visible focus treatments cover header, row, and pill links. The packaged
stylesheet removes decorative link transitions when reduced motion is
requested.

The Cloud dashboard places edit controls over the frame so entering edit mode
does not move widgets. **Move forward** and **Move back** provide alternatives
to dragging. A widget with declared settings also offers **Customize**. These
controls and per-entry settings belong to the host; the portable frame keeps
its presentation contract.

## Runtime

Widgets render complete server HTML and make no network requests. Native links
work without browser code. Client-side navigation enhancement remains the host's
responsibility.

## Example

```tsx
<Widget
  title="Workspace"
  meta="last 24h"
  icon="ti ti-layout-dashboard"
  href="/workspace"
>
  <WidgetStat
    value={12}
    label="Open tasks"
    sub="3 due today"
    accent={{ tone: "amber", icon: "ti ti-clock", text: "Today" }}
  />
  <WidgetList
    grow
    items={[
      {
        label: "Review release notes",
        sub: "Platform",
        meta: "today",
        icon: "ti ti-notes",
        iconTone: "blue",
        href: "/tasks/12",
      },
    ]}
  />
  <WidgetStatus tone="success" title="All services operational" />
  <WidgetPills
    pills={[
      { label: "Teams", value: 4, href: "/teams" },
      { label: "Projects", value: 9, tone: "blue" },
    ]}
  />
</Widget>

<Widget title="Release" size="compact" icon="ti ti-rocket">
  <WidgetHero
    title="Ready to ship"
    subtitle="All required checks passed"
    icon="ti ti-circle-check"
    tone="emerald"
  />
</Widget>

<WidgetStatus tone="warning" title="Delayed" />
<WidgetStatus tone="danger" title="Unavailable" />
<WidgetStatus tone="info" title="Maintenance scheduled" />
```
