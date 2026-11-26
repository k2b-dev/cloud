---
name: k2b-ui
description: >
  Build screens with @k2b/ui/v2, the primitives that own spacing, lines and
  type so an application writes no layout CSS. Use this skill whenever code
  imports from @k2b/ui/v2 or a task asks for a new or rebuilt screen in a
  Cloud application or another SolidJS app on @k2b/ui: workspaces, sidebars,
  heads, status rows, lists, tables, records, groups, forms, notices, mail-like
  readers. Covers which primitive to pick, the rules and why, recipes with
  code and picture, the messages of the checks with their fixes, and how to
  see what you built (describeV2 outline, layout measurement, screenshot).
---

# Build screens with @k2b/ui v2

v2 primitives own spacing, hairlines, heights and type. An application only
chooses **which** primitive stands **where** and fills it with data. There is
no `class`, `style`, `size` or `gap` to tune, and no app CSS outside `Canvas`.
That is the point: two agents building the same screen get the same result.

`@k2b/ui/v2` is **provisional** until the maintainer approves it. Names and
props may change in any release; check the types of the installed version.

## Start here

1. Find the screen in the task table below and open its recipe in
   `recipes/` (code) and `images/` (picture at 1440 and 390 px). Read
   [recipes](references/recipes.md) for what each one shows. The same
   recipes stand live, with their states and generated props, on the topic
   pages of the UI section in Fibel (`/en/ui/v2/<topic>`; `read_doc`
   returns each as Markdown with the code).
2. Copy the recipe, keep its structure, replace the data. Change the
   arrangement only where the task really differs.
3. Check it, cheapest first (see "See what you built"). Fix every finding
   before you look at a picture.
4. Something has no primitive? Do not write CSS or a wrapper. Use the
   nearest primitive, write `// k2b-ui gap: <what is missing>` at that
   place, and name the gap in your report. The section "Not in v2 yet" of
   each topic page lists the gaps known now; it stays current.

Read [primitives](references/primitives.md) for every prop and place,
[mistakes](references/mistakes.md) when a check reports something, and
[seeing](references/seeing.md) for the feedback tools.

## Set up

```tsx
import { Workspace, Pane, Bar, List, Row } from "@k2b/ui/v2";
```

- Styles: `@k2b/ui/v2.css`. Every v2 class lives under the scope class
  `k2-ui` on an ancestor, never set by a screen.
- In a Cloud app, a page opts in with `ui: "v2"` on its layout; the layout
  puts `k2-ui` on the page's main area and loads v2.css with the app's accent
  tokens. Outside Cloud, the page template puts `class="k2-ui"` on `<body>`
  and loads `@k2b/ui/v2.css`.
- A screen is a component that returns one `Workspace`.
- Strings come from the app's message catalog; recipes inline German sample
  text only to look like the real thing.

## What to use for what

| You want to show | Use | Recipe |
| --- | --- | --- |
| an app's frame: sidebar, head, columns | `Workspace` with `sidebar`, `head`, `primary` | all |
| the app's sections in the sidebar | `Nav` | `list-detail.tsx` |
| views of the page, or areas of a record | `Tabs` (in the head `Bar`, or as `Pane` head) | `mail.tsx`, `record.tsx` |
| where a sub-page stands | `Path` in the head `Bar start` | – |
| the one main statement and key figures | `StatusRow` in `Pane status` | `table.tsx` |
| many like things, one per line | `List` of `Row` | `mail.tsx` |
| a thing with a face (a base, a file, a table, a storage) | `Mark` (`Row mark`, `Nav` item `color`, `Tiles color`) | `overview.tsx` |
| an overview of things with figures, people and a history | `Tiles variant="card"` (+ `create` for the new one) | `overview.tsx` |
| who did what | `Digest activity` | `overview.tsx`, `home.tsx` |
| several people at once (a team, who has access) | `Avatar.Stack` | `overview.tsx` |
| a short history beside a number | `Spark`; in a cell `Cells.Cell trend` | `home.tsx` |
| many like things with columns | `Table` | `table.tsx` |
| a large table: select rows, groups, sticky first column | `Table` with `rowKey`, `select`, `group`, `sticky`; `StatusRow selection` | – |
| rows the person sorts by a column | a column's `sort` (`href` to the sorted page) and the table's `sort` (the column sorted now) | – |
| a list or table people filter, sort or group | `defineListQuery` (`@k2b/ui/v2/list-query`), then `FilterBar` in `Pane status` above the `StatusRow` and `ListOrder` in its `filters` | `filtered-table.tsx` |
| filter values that load (people, customers) | a `lookup` field: `FilterBar` opens `Lookup`; in a form, `Lookup` itself | `filtered-table.tsx` |
| saved views of a list | `FilterBar views` with the app's `ViewStore`s (cookie, own table, none); leave it out and nothing is saved | – |
| a list beside the open entry | `Pane.Split` with a `Pane detail` | `list-detail.tsx` |
| a record (customer, contact) | `RecordHead` in the head, `Tabs`, `Pane side` | `record.tsx` |
| 2–4 key numbers side by side | `Cells` with `Cells.Cell` | `record.tsx` |
| a titled part of a page | `Section` (title, count, ≤ 2 actions, `more`) | `record.tsx` |
| what belongs together (a delivery, a thread) | `Group`; `folded` when done | `record-groups.tsx` |
| the way of a thing (arrived → … → paid) | `Steps` | `record-groups.tsx` |
| the newest few on a first page | `Digest` | `record.tsx` |
| labels with values | `Facts` (`inline` for one line) | `record.tsx` |
| something wrong, waiting, a person's note, an AI summary | `Notice` with `tone` (`bad`, `warn`, `note`, `ai`) | `list-detail.tsx` |
| one statement that stands out in a column (not a message) | `Band tone` with `Text` | – |
| something that needs this person | `Row yours` or `Chip yours` | `record-groups.tsx` |
| a form | `Field` / `Field.Row` with `Input`, `Select`, `DateInput`, `Check`, `Choice` | `form.tsx` |
| reading text, an email body, a page of Markdown | `Prose` | `content.tsx`, `mail.tsx` |
| attachments, media files, like things to press | `Tiles` | `content.tsx`, `mail.tsx` |
| a state, tag, amount, count | `Chip` | `table.tsx` |
| a person's or agent's picture | `Person image` on `Avatar`, `RecordHead avatar`, `Row avatar` (initials stay while it loads or fails) | – |
| a deed under way (saving, sending) | `Button busy`; a deed that cannot be taken now: `disabled` | `actions.tsx` |
| a toggle that is on or off (favourite, reply to all) | `Button pressed` (`true` on, `false` off) | `actions.tsx` |
| a token, key or ID to read and copy | `Facts` item with `mono` and `copy` | – |
| a free drawing (map, plan) | `Canvas` inside a primitive | `content.tsx`, `record.tsx` |
| a chart in a v2 screen | `Chart` from `@k2b/ui` (data types in `@k2b/ui/charts`) with `style={{ height: "100%" }}` in a `Canvas` with `height`, directly in its `Section`; no data: `Empty` in place of the `Canvas` | – |
| nothing to show (yet) | `Empty` where the data would stand; a table takes `empty` | `states.tsx`, `table.tsx` |
| data still loading | `Loading` where the list will stand; a table takes `loading` | `states.tsx` |
| data that failed to load once | `Failed` with "Erneut versuchen", in place of the data only | `states.tsx` |
| a search in a head or status row | `Input type="search"` with `icon`, `onKeyDown`, `ref`, `end` | – |
| a link that opens in place | `href` plus `onNavigate` on rows, tabs, nav entries, actions, buttons, chips | – |
| more deeds behind "…", or a choice of deeds behind a button | `Menu` with `items` (submenus, ticks, `danger`) | `actions.tsx` |
| the same deeds on a right-click or a long press on a row | `Menu.Context` around the `Row`, plus a `Menu` in its `end` | `actions.tsx` |
| a small panel behind a button (a preview, details) | `Popover` with `title` and `content` | `actions.tsx` |
| a short hint on a button | `Popover tip` around the `Button` | `actions.tsx` |
| "done" after a deed, with a way back | `useToast()`, then `toast(text, { undo })` | `dialogs.tsx` |
| a short task above the page (invite, save as a template) | `Dialog` with `title`, `foot`, `open`; a sheet on the phone | `dialogs.tsx` |
| a question before something that cannot be taken back | `await Dialog.confirm({ title, confirm })` | `dialogs.tsx` |

## The rules, and why

1. **One way per task.** Each need above has one primitive. A second way
   is how screens drift apart.
2. **Primitives own spacing, lines and type.** You never pick a gap, a
   padding or a font size. The checks fail the build otherwise.
3. **Fixed places, not free children.** Slots such as `head`, `status`,
   `sidebar`, `start`, `end`, `actions`, `marks` say where a thing goes. A
   plain `<div>` in a `Pane` is a finding.
4. **Variants only for meaning.** `tone`, `status`, `variant` say ok,
   waiting, wrong, AI, yours. Size comes from the place.
5. **Wrong fails at once.** Types reject a missing label; the rule and
   `describeV2` name the fix.
6. **Recipes for whole screens.** Copy one instead of composing from
   scratch.
7. **Rows and columns stay dense.** In a table with column `width`s, long
   text is cut with "…" and the row keeps its height; columns that matter
   less `drop` on the phone, and a table wider than a phone gets
   `phone(row)` (two-line rows). A small table without widths (a few rows
   in a group) wraps its cells instead; keep its texts short.
8. **Round is what you press; square is what structures.** Buttons, chips,
   inputs and tiles are round; panes, bands, sections, groups are square.
9. **Lines separate groups, not entries or the parts of one thing.** No
   line under a section head, none between its entries, none inside a
   `Group`.

One primary action per page: the filled `Button variant="primary"` in the
head, mirrored as `Workspace primary` so the phone shows it. A form page
without a head action has its "Save" as the one primary in its footer
`Bar`; a form shown beside a page that has a head primary saves with a
default (framed) button. An open dialog or sheet is a surface of its own
and has its own one primary (such as "Erstellen").

What a list has open belongs in the address: render the `Pane detail` only
while the address names an entry, give its `back` an `href` to the list
without that entry, and make rows open with `href` (plus `onNavigate` to
open in place). Reload, back and forward then show the same page.

"Erneut versuchen" belongs to one place only: `Failed`, standing where data
that failed to load once would stand. A connection that retries on its own
says so in the `StatusRow` without a button; something a person must fix is
a `Notice` that names the deed.

## How a screen looks: dense, clear, with faces

The target (design pass 26.11.): dense, clear, space-efficient, tailored
and appealing. Dense is not busy: show more, never the same thing twice.

1. **Each thing carries its mark.** Every row, card and sidebar entry for a
   thing leads with its `Mark` (colour and symbol, or thumbnail) or a
   person's `Avatar`; without its own colour it takes its kind's, never grey.
2. **The first line says what counts today.** `StatusRow` lead or `Cells`:
   a statement with a number, chips with a tone for what lets one act. A
   count such as "6 Einträge" is never the biggest text.
3. **A state is colour, symbol and word.** A value with a limit gets a bar,
   a short history a `Spark`.
4. **Space structures, lines separate groups.** Group heads are text;
   no box inside a card.
5. **No empty half.** A detail only while something is open, a side column
   only when it is full.
6. **People stand beside what they did:** avatars, stacks, `Digest
   activity` with the thing's mark.
7. **Four type sizes** (12, 13, 14, 18), set by the primitives.
8. **Sample data is dense and real**: colours, people, states; never
   "Tabelle 1".

## Primitives in one line each

- **Frame:** `Workspace` (sidebar, head, primary), `Pane` (head, status,
  `width`, `detail`, `side`), `Pane.Split`, `Bar` (start, end), `Band`
  (`tone`), `Cells`, `Tiles`, `Canvas`.
- **Structure:** `Section`, `Group`.
- **Content:** `List`, `Row`, `Table`, `Facts`, `Text` (`type` meta, row,
  body, lead), `Prose`, `Inline`, `Icon`, `Mark`, `Avatar`, `Avatar.Stack`,
  `Chip`, `Progress`, `Spark`, `Steps`.
- **Controls:** `Button`, `Field`, `Field.Row`, `Input`, `Select`,
  `DateInput`, `DatePicker`, `Check`, `Choice`.
- **Components:** `Nav`, `Tabs`, `Path`, `StatusRow`, `Notice`, `Digest`,
  `RecordHead`, `FilterBar`, `ListOrder`, `Lookup`.
- **Overlays:** `Dialog`, `Dialog.confirm`, `Menu`, `Menu.Context`,
  `Popover` (panel or `tip`), `useToast`.
- **States:** `Empty`, `Loading`, `Failed`.
- **Tools:** `describeV2`, the tokens (`typeRoles`, `heights`, `textEdge`),
  and `@k2b/ui/v2/testing` for Playwright tests.

Not there yet (write a `k2b-ui gap` comment, never a replacement):
the mail and chat composer and a Markdown editor (come from `@k2b/editor`),
a code block with highlighting, an image or video viewer, and an assistant
message or answer card.

Filters, sorts and groups have exactly one way: declare them once with
`defineListQuery`, show them with `FilterBar` and `ListOrder`. The state
lives in the address through that declaration; the server reads it with
`parse`, and the app filters itself, on its server, with its own access
checks (`@k2b/ui` filters nothing and stores nothing). In the island,
keep one signal that mirrors that state: start it with what the server parsed
and set it in `onChange`, as the recipe does. Never parse search parameters
yourself, keep filter state the address does not hold, or build filter chips
by hand. Read [list queries](references/list-queries.md).

## See what you built

Cheapest first; stop at the first step that finds something, fix, repeat.

1. **Types** reject wrong props (a `Button` with only an icon and no
   `label`, a `Chip` with two kinds).
2. **The rule `v2-app-layout-css`** (`bun run check` in the Cloud monorepo)
   reports `class`, `style`, spreads and stylesheets outside `Canvas`.
3. **The outline** from `describeV2` lists every part with its text and
   count, and ends with `Problems` when something is off. About 30 lines,
   no picture.
4. **The layout measurement** (`measureV2Layout`) checks edges, double
   lines, type roles and grips at 1440 and 390 px.
5. **A screenshot** only when the outline leaves a doubt.

In the Cloud monorepo one command runs all five on a screen file:

```bash
bun packages/ui/scripts/v2-preview.ts path/to/screen.tsx --text   # 1-3, no browser
bun packages/ui/scripts/v2-preview.ts path/to/screen.tsx --png out # 1-5
```

Details, the outline format and use outside the monorepo:
[seeing](references/seeing.md).

## Most common mistakes

| Finding | Fix |
| --- | --- |
| `class on <div> in a v2 screen` | delete it; pick the primitive that owns that look |
| a segmented control (or a row of pressed buttons or chips) that switches views or panels | `Tabs`; a segmented control only chooses a value, such as a state or a width |
| own `URLSearchParams`, filter state beside the address, a row of filter `Chip`s or a filter `Popover` | declare the list with `defineListQuery`; show it with `FilterBar` and `ListOrder` (`filtered-table.tsx`) |
| `plain <div> in Pane` | put the content in `Band`, `Section`, `Group`, `List`, `Table` or `Notice` |
| `loose text in Pane` | wrap it in `<Text>` |
| `Button … stands alone in Pane` | move it into a `Bar end`, `Row action`, `Section actions` or `Notice actions` |
| `2 primary buttons` | keep one `primary`; the others are default or `ghost` |
| `primary action is hidden at this width` | add `Workspace primary` |
| `floating main action … covers …` | the form leaves on the phone: put it in a `Pane detail` or its own route |
| `Table … wider than its column` | give the table `phone(row)`; give a `Pane detail` beside it a `width` |
| `Group … stands in another Group` | flatten: one `Section`, several `Group`s |
| a line under a section head | remove your own divider; `Section` draws the one line |
| icon button without a name (type error) | give `label="…"` |

More, with before and after: [mistakes](references/mistakes.md).
