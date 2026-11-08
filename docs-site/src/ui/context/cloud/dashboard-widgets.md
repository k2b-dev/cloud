# Cloud dashboard widgets

Cloud applications can expose bounded `WidgetResponse` JSON endpoints to the shared dashboard. The endpoint, session, permissions, route, and response contract are Cloud-specific; the rendered widget components also exist portably in `@k2b/ui`.

## Use Cloud dashboard widgets

Register an endpoint when users need a compact cross-application summary or a direct route into a common task. Do not reproduce an entire application screen.

Use the portable widget components directly when the host already owns its data and layout and does not need Cloud endpoint discovery.

The widget's header icon sits in a soft chip of its source app's color,
from that app's declared `appearance.accent`, in loading, error, locked, empty,
and loaded states. A widget whose app declares no accent uses the
dashboard's color. In a small dashboard tile, a failure message with
Try again shows no status icon, so the message and the button fit the tile
on a 320px phone.

## Description panels

`DescriptionPanel` from `@k2b/cloud/descriptions` maps one portable
description onto the `@k2b/ui` dashboard components: `DashboardFrame`,
`ChartExplorer`, `StatGrid`, `DataTable` and `DescriptionList`. Chat, Pulse, Code pages and the
chart showcase use it, so a page tree maps one to one onto components:

| Node | Drawn as | Props from the node |
| --- | --- | --- |
| Page | `DashboardGrid` | the host draws the page head |
| Section `{ title, description, icon, color }` | `DashboardSection` | `title`, `description`, `icon`, `iconColor` |
| Chart `{ kind, … }` | `DashboardFrame` without title around `ChartExplorer` | `title`, `subtitle`, legend and table rows from the chart description; panel `width`, content `height` |
| `{ block: "stats", items }` | `StatGrid` of `StatCell` tiles, always the whole row | per item `label`, `value` in its `format`, `icon`, `tone`, `delta`, `compare`, `trend`; states per tile |
| `{ block: "table", columns, rows, search?, groupBy? }` | `DashboardFrame` with `reserve`, typed `DataTable` | search field and grouping chip in `tools`, typed columns (`type`, `format`, `states`, `priority`), sortable headers |
| Chart without values `{ kind, title, subtitle?, empty? }` | the same `DashboardFrame` and `ChartExplorer` as the chart, in its empty state | `title`, `subtitle`, `empty` as the sentence; only these keys, and a known `kind` |
| `{ block: "details", title, subtitle?, items }` | `DashboardFrame` with a `DescriptionList` in rows | per item `label`, `type` (`text`, `number`, `date`, `datetime`, `ref`), `value`, `format`, validated like Chat's details view; a missing value is a dash; `height` of the panel, more fields scroll |
| `{ block: "budget" }` | `DashboardFrame` `compact`, `BudgetList` | the block's fields as `BudgetList` props; 240 px by default |
| `{ block: "balance" }` | `DashboardFrame` `compact`, `BalanceSummary` | the block's fields as props; 56 px |
| `[{ type: "flow", … }]` or `{ block: "flow", items }` | `DashboardFrame` `compact`, one `FlowAmount` per entry | each entry as `FlowAmount` props; 72 px |
| Anything this build cannot draw | `DashboardFrame` with the host's `slot`, or "This view cannot be shown here." | `title`, `subtitle` |

A page that has no values for a chart sends its empty form; every other
chart description must carry at least one value, as the chart schema
requires. Each panel takes the page's `state`, `asOf` and `onRetry` and its own
`empty` sentence; `DescriptionPanel` passes them to the frame, the explorer
or the tiles. Its own words, such as the search label and "Nothing to show
for this period.", follow the same locale.

## Import

```ts
import type { WidgetResponse } from "@k2b/cloud/contracts";
```

## Endpoint contract

Cloud invokes the widget on behalf of the signed-in user using a target-bound credential, not the user's session cookie. The handler applies every required permission, keeps its query bounded, and returns:

- `200` with `WidgetResponse`;
- `204` when there is no relevant content;
- `403` when the user lacks access;
- another error only for a real failure.

One slow or failed endpoint must not block the dashboard.

## Accessibility

Every stat needs a label and context. Widget and row links need destination-specific text. Status blocks must state their result in text instead of relying on tone or icons.

## Runtime

The dashboard is one board of widgets in three fixed sizes, `small`, `medium`, and `large`, on four columns or two on phones. The page renders every widget's `@k2b/ui` frame at its final size with a loading state. The browser then reads all widgets from Core in one stream (`POST /api/widgets/v1`), with entry ids, sizes, and settings; each fills its frame as soon as its app answers, within its own 8-second budget. A slow widget says so after three seconds; a widget that fails or times out shows a calm inline state with **Try again**, which asks only that widget again. A locked or empty widget keeps its frame. Endpoint responses are JSON; applications never return Solid elements through this contract. A handler reads the requested size and settings with `getWidgetRequest(c)` and returns content that fits them.

Edit mode offers **Move forward** and **Move back** alongside dragging and keyboard movement. **Customize** opens declared settings in a dialog, or a bottom sheet on phones, and reloads that entry quietly after **Apply**. **Done** saves settings; **Cancel** restores them. Widgets with settings can appear several times with independent entry ids and values. Widgets without settings appear once. Framework validation runs on every call; handlers authorize each chosen resource.

## Example

```ts
const body: WidgetResponse = {
  title: "Recent notes",
  icon: "ti ti-notebook",
  href: "/app/notebooks",
  blocks: [
    {
      kind: "list",
      grow: true,
      items: notes.map((note) => ({
        label: note.title,
        sub: note.notebookName,
        href: `/app/notebooks/${note.notebookId}/notes/${note.id}`,
      })),
    },
  ],
};

return c.json(body);
```
