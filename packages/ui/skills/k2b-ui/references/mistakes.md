# Mistakes, what reports them, and the fix

Each entry: the message (shortened), why it is wrong, the fix. Agents trained
on Tailwind make the first group most; the second group comes from building
without a recipe.

## Layout written by the app

### `class on <div> in a v2 screen` (rule `v2-app-layout-css`)

The same for `style`, `classList`, `className`, `{...spread}` on a plain
element, a `ref` that sets styles, `<style>`, and `import "./x.css"`.
v2 primitives own spacing and type; a class is a second way to lay out.

```tsx
// wrong
<div class="flex gap-2 p-4"><Chip status="ok">Aktiv</Chip><Chip tag>Neu</Chip></div>
// right: in a column or bar
<Inline><Chip status="ok">Aktiv</Chip><Chip tag>Neu</Chip></Inline>
```

Padding around a notice, a list or a toolbar is never needed: every band
already carries the text edge and reaches both column edges.

### `innerHTML on <div> … use Prose`

Markup brings its own classes. Reading text goes into
`<Prose markdown={…} />`, which renders safe Markdown.

### `<Canvas> stands as the root of a component` / `outside a v2 primitive`

`Canvas` takes its size from the primitive around it. Return the drawing
from your component and place it: `<Band><Canvas label="Karte"><Map
/></Canvas></Band>`.

### `… restyles the v2 class .k2-row` (rule, in an app stylesheet)

App CSS may not target `k2-` classes, `data-k2-` attributes or set `--k2-`
tokens. If a primitive looks wrong, report it as a gap of `@k2b/ui`.

## Structure

### `plain <div> in Pane "…": no primitive owns it` (outline)

Rule 3, fixed places. A wrapper element in a `Pane`, `List`, `Section`,
`Group`, `Band` or `Workspace` has no edge, no line and no type role.

```tsx
// wrong
<Pane><div><h2>Kontakt</h2><p>+49 30 5550 142</p></div></Pane>
// right
<Pane>
  <Section icon="phone" title="Kontakt">
    <Facts items={[{ label: "Telefon", value: "+49 30 5550 142" }]} />
  </Section>
</Pane>
```

### `loose text "…" in Pane` (outline)

Text needs a type role: `<Text>`, `<Text type="body" weight="strong">`, or a
`Notice` when it is a message.

### `Button "…" stands alone in Pane and takes its full width` (outline)

A button has a place: `Bar end` (a head or a footer bar of a form), `Row
action`, `Section actions`, `Group actions`, `Notice actions`, `Tiles
more`. A form's buttons go in a `Bar` at the end of the pane.

### `Group "…" stands in another Group` (outline)

Groups are never nested. Use one `Section` with several `Group`s; inside a
group use `Text`, `Table`, `Facts`, `Row`.

### `2 primary buttons (…)` (outline)

One filled action per page. The others: default (framed), `ghost`, or
`text` in heads and row ends.

### `the primary action is hidden at this width` (outline at 390 px)

Head actions hide on the phone. Give `Workspace` the same action as
`primary`; it floats there. A head button that must stay gets `keep`.

### `the floating main action … covers "Speichern" at this width` (outline at 390 px)

On the phone `Workspace primary` floats at the bottom right. A form at the
end of a pane slides under it. A form or dialog is its own route on the
phone; beside a list it is a `Pane detail`, which leaves at that width.

### `Table "…" is 312 px wider than its column at this width` (outline at 390 px)

The widths of the columns that stay do not fit the phone, so the last
columns (often the amount and the deed) are cut off. Give the table
`phone(row)`; `drop` alone is rarely enough. The same happens at 1440 px
when a `Pane detail` beside the table has no `width`.

### `Failed "…" stands in a bar` (outline)

"Erneut versuchen" belongs only where data that failed to load once would
stand. In a status row or bar, a connection that retries on its own says so
in words (`StatusRow lead` or a fact) without a button; something a person
must fix is a `Notice` that names the deed.

### A line under a section head, between entries, inside a group

Rule 9. You drew it with your own element or a `Bar` between entries.
`Section`, `Group` and `List` draw the lines they need; remove yours. A
`Bar` belongs at the top (head, status) or as a form footer.

## Measured layout (`measureV2Layout`)

- `line … stops 20 px short of the left … edge of its column`: something
  pads a band. Remove the wrapper; the band must stand directly in the
  `Pane`.
- `double line: … and … at … px`: two parts draw a line at the same place,
  usually a `Bar` right under a `Bar`, or a `Band` before a `Section` end.
  Drop one of them.
- `text outside the type roles: 15px/22px 500`: own font sizes. Use
  `Text type`; emphasis is `weight`, never a size.
- `grip …: pill centre … px off its line`: a primitive bug. Report it.

## Types

- `Property 'label' is missing` on `Button`: an icon button needs a name.
- `Type '"red"' is not assignable to type 'Status'`: tones are meanings
  (`ok`, `warn`, `bad`), not colours.
- `Property 'class' does not exist`: no part takes classes; pick the part
  that owns the look.
- `Object literal may only specify known properties` on `Chip`: one chip is
  one kind (`status` or `tag` or `amount` …).

## Habits that pass the checks and still look wrong

- A `Text type="lead"` as a page title inside a pane: the title belongs in
  the head `Bar start`, the lead statement in `StatusRow lead`.
- Building a list from `Band`s: many like things are a `List` of `Row`s
  or a `Table`.
- A "Retry" button of your own after an error: data that failed to load
  once is `Failed` in its place; a connection that retries on its own says
  so in the `StatusRow` without a button; something a person must fix is a
  `Notice tone="bad"` whose action names the deed.
- An empty list as a `Band` with muted text, or nothing at all: use `Empty`
  (or `Table empty`) with one sentence and one way out.
- A spinner or a blank pane while data loads: use `Loading` (or `Table
  loading`) with as many rows as usually come, so nothing moves.
- An open entry kept only in state: the detail is lost on reload. Put it
  in the address, give `Pane detail` a `back` with `href`, open rows by
  `href` and `onNavigate`.
- Colour without a word: a red dot alone says nothing; `Chip status="bad"`
  carries the word.
- `marks` on a two-line `Row`: they add a third line. Use `end` or three
  lines.
