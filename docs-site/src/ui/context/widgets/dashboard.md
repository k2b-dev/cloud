# Widget composition

The widget family composes compact dashboard blocks from semantic presentation
data. It does not fetch endpoints or depend on a dashboard registry.

## Use Widget composition

Use `Widget` as the standard frame and add only the blocks the summary needs:

- `WidgetStat` for one labeled value;
- `WidgetList` for short linked or static rows;
- `WidgetStatus` for health or state;
- `WidgetPills` for compact labeled values;
- `WidgetHero` for one centered all-clear or spotlight message.

The host owns data loading, permissions, refresh behavior, navigation, and
placement. `Widget` is the only frame; use `size="content"` when the host owns
the height and omit `href` when the header is not a destination.

## Import

```tsx
import {
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
build its compact header. `size` is `"content"`, `"compact"`, or `"standard"`;
the default standard frame is 25rem high, compact is 12rem, and content has no
fixed height. When `href` is set, only the header becomes a link, so links
inside the body remain valid.

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

## Runtime

Widgets render complete server HTML and make no network requests. Native links
work without hydration. Client-side navigation enhancement remains the host's
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
