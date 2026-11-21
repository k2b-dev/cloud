# Section and Field

`Section` is one topic of an object: a symbol in a 20 px tile, a title with its
count or state, at most two quiet text controls, and its content. In a column,
such as a detail panel, and on a full page a section draws no outer frame: one
line, one owner. Its container draws the hairline between topics, the detail
panel itself and any other host with `k2b-divided` (Cloud flat, K9).
`Section.Part` divides a section into sub-topics without a frame of its own,
and `Field` shows one value with its label.

The heading follows three levels (K17): the title is 13 px bold in a column and
14 px bold on a page, the count is a quiet grey number right after the title,
and the content below is rows (13 px) and meta (12 px). In a detail panel every
row starts on the title's text edge; the symbols stand on one axis. Text
buttons in the heading are grey and turn dark on hover: their place marks them,
and blue stays for the one main action of the page.

### Area colour

Pass `iconColor` with the colour of the section's area on a dense record page,
such as money, goods, or contact. The symbol then sits in a 20 px tile of that
colour. It is the only place the area colour shows. Never use a status hue
(green, red) or a colour near the AI plum.

## Use Section

Give each topic of a page its own `Section` and lay the sections out with the
page's own grid. Use `size="md"` on pages and keep the default `size="sm"` in
panels and other narrow columns. Order the sections by use: what people work
with first, context later.

A section never holds a frame. A section inside another section, a
`DetailPanel.Group`, a summary, `Paper`, a dialog, a panel dialog, or a settings
section loses its own frame automatically, so frames never nest (K14). Divide one topic
with `Section.Part`, not with a nested section. Do not wrap a section in `Paper`
or add an application border, shadow, or padding around it.

Inside `DetailPanel` a section stands flat because the panel sets its default
`frame` to `"none"`. Leave `frame` unset there. Pass `frame="none"` only where a
host outside a panel frames its sections itself.

### Tones

A tone is named after a status token and colors the symbol tile, never the
fill or the title (K8): `neutral` (the default), `success`, `warning`, `danger`,
`info`, and `ai` for content the AI delivered. Color is never the only signal:
the heading also says the state in words, usually through `meta`, such as
"Expires soon" with `warning` or "Payment failed" with `danger`. Use a tone only
when the section's state matters for a decision. Do not use one to decorate or
to tell sections apart.

### Restricted visibility

Visibility is a marker, not a color. When only some people see a section, pass
`restricted` with the app's words for who sees it, such as "Only with
permission" or "nur mit Recht". The section shows a lock and these words after
its title and adds them to its accessible name. It combines with any tone and
keeps the neutral tile by default, so green stays reserved for success.

### States

Pass `state="loading"` while the content loads: placeholder rows at the height
of a loaded row take the body's place, and the heading stays where it is. Set
`loadingRows` to the number of rows the loaded body usually shows. Pass
`state="error"` with `errorMessage` and `onRetry` when the content did not load;
the section names what failed and offers "Try again" without a box. An empty
topic keeps its heading with `count={0}`, which reads "None yet", and its one
control, such as "+", so people learn what the topic can hold.

### Collapsible sections

Set `collapsible` for secondary topics. The whole heading row is one
disclosure button. In a frame it fills the frame's top on hover; flat, hover
colors the title and chevron. Collapsed sections at the end of a detail panel
go into a titled `DetailPanel.Group`; each then is one row with a hairline
below it. Pass `summary` for one line that says what a
closed section holds. Opening moves only what lies below the heading row. The
content stays mounted while closed, so unsaved input survives. Control the
state with `open` and `onOpenChange`, or start it open with `defaultOpen`.

### Field

Use `Field` for a label and one value. The label stands on the left and the
value on the right; a value that does not fit beside its label moves below it.
Pass `layout="stack"` for a value that is a sentence, such as a note. Pass
`kind="email"` for an address: it becomes a mail link that breaks only after
its `@`. Pass `copy` for identifiers and numbers people copy: `true` copies the
text value, and a string copies that string, such as the full form of a value
that the field shortens. The copy button always keeps its place, shows on hover
and focus, and is always visible on touch. A long value ends with an ellipsis
and shows in full in its hint.

Use `DescriptionList` instead when a whole list of terms needs column
alignment, editing in place, or a wide-row leader.

## Group and area

Below a section there are exactly two levels (K17). An application invents no
third one.

`RowGroup` is a group: a sort word for the rows of one list, such as tasks by
status. Its head is 36 px on the page's quiet ground with the name in 13 px
bold, its count, and at most one action. It disappears when it has no rows.

`Area` is a thing the rows hang on, such as a stack with its lists. Take an
area when it exists also empty, has a state of its own, or two or more actions
of its own; otherwise take a group. Open, an area is a square area of its own
with a 56 px head of two lines (a 20 px tile with its number, the name in 14 px
bold, state and actions at the right, a 12 px meta line) and its rows on a rail
that starts on the name's text edge; open areas stand 8 px apart. With
`collapsible`, a closed area is one 40 px row like a list row: name, state,
count, and the chevron, without a surface or a gap. Only the person opens or
closes it, and opening moves only what lies below its head. An area holds rows
or one more area (two levels at most), never a group. An empty area says so
with `empty`, such as "No list yet".

```tsx
<Area name="Stack 2" marker={2} collapsible count={3} meta="3 lists · 2 photographed"
  state={<StatusBadge tone="warning" label="Open" />}
  actions={<Button size="sm" variant="secondary">No further list</Button>}
  empty="No list yet">
  <For each={lists}>{(list) => <ListRow list={list} />}</For>
</Area>
```

## FactGroup

`FactGroup` is a group of facts in the quiet column beside a detail (K17): a
title with its symbol and one pencil (`onEdit`), then each label in 12 px grey
and its value in 13 px dark. `copy` puts a copy button at values people carry
elsewhere, such as a phone number, an address, an IBAN, or a code. Groups stand
apart by space, without lines. A group of one value belongs into another group.
In a column under 360 px each label stands above its value. Put the groups
into a column of at most 400 px.

```tsx
<FactGroup title="Bank" icon="ti ti-building-bank" onEdit={editBank} items={[
  { label: "IBAN", value: "DE00 1234 5678 9012 3456 78", copy: true },
  { label: "Holder", value: "Henrike Vossberg" },
]} />
```

## FieldGrid

`FieldGrid` puts the fields of one row on one grid (K5). Every label row is
20 px, so the controls share their top edge, and a description or an error only
makes its own field taller below its control. A field without a label keeps the
empty label row. In a column under 360 px the fields stand one under the
other, and three or four fields stack earlier, so no field gets narrower than
160 px. Choose `columns` from 2 to 4.

```tsx
<FieldGrid columns={3}>
  <TextInput label="Place" description="Shelf and row" value={place()} />
  <NumberInput label="Daily rate" value={rate()} />
  <DatePicker label="Next check" value={next()} />
</FieldGrid>
```

## Import

```tsx
import { Area, FactGroup, Field, FieldGrid, RowGroup, Section } from "@k2b/ui";
```

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `title` | `JSX.Element` | required | Names the topic. |
| `icon` | `string` | none | Icon class in a 20 px box with 4 px corners. |
| `iconColor` | `string` | none | The area colour as a CSS colour; sets the icon in a 20 px tile of that colour. |
| `size` | `"sm" \| "md"` | `"sm"` | `sm` for panels and narrow columns, `md` for page topics. |
| `frame` | `"line" \| "none"` | `"line"`, `"none"` in a `DetailPanel` | `line` keeps a page section's inset; neither draws an outer frame. |
| `tone` | `"neutral" \| "success" \| "warning" \| "danger" \| "info" \| "ai"` | `"neutral"` | Colors the symbol tile by status. |
| `restricted` | `string` | none | Lock and words for restricted visibility. |
| `count` | `number` | none | Quiet number after the title; `0` reads "None yet". |
| `meta` | `JSX.Element` | none | Short state after the title, such as "2 of 4 done". |
| `description` | `JSX.Element` | none | One quiet line below the title. |
| `actions` | `JSX.Element` | none | At most two quiet controls at the end of the heading; ghost and text buttons read grey. When the row is too narrow, they move to a second line at the end, so the title stays whole. |
| `footer` | `JSX.Element` | none | Commands for the whole topic, at the end of the body. |
| `state` | `"ready" \| "loading" \| "error"` | `"ready"` | Replaces the body while loading or after an error. |
| `errorMessage` | `JSX.Element` | generic sentence | Says what did not load. |
| `onRetry` | `() => void` | none | Shows "Try again" in the error state. |
| `loadingRows` | `number` | `3` | Placeholder rows while loading. |
| `level` | `2 \| 3` | `3`, `2` for `md` | Heading level. |
| `collapsible` | `true` | none | Makes the heading row a disclosure button; excludes `actions`. |
| `summary` | `JSX.Element` | none | One line a closed collapsible section shows. |
| `defaultOpen`, `open`, `onOpenChange`, `disabled` | | | Uncontrolled or controlled disclosure. |

`Section.Part` takes `title` and `children`. `Field` takes `label`, `value` or
`children`, `copy`, `kind` (`"text"` or `"email"`), and `layout` (`"row"` or
`"stack"`).

`RowGroup` takes `title`, `count`, one `action`, `level` (3 to 5, default 4),
and the rows as `children`. `Area` takes `name`, `marker` or `icon` for its tile,
`state`, `count`, `actions`, `meta`, `empty`, `level`, and the rows as
`children`; `collapsible` with `defaultOpen` (default open) or `open` and
`onOpenChange` lets the person close it. `FactGroup` takes `title`, `icon`,
`items` (`label`, `value`, `detail`, `copy`), `onEdit`, and `level`.
`FieldGrid` takes `columns` (2, 3, or 4; default 2) and the fields as
`children`.

## Accessibility

A section is a `section` region named by its heading; `restricted` words are
part of that name, so a screen reader hears "Reports, Only with permission". A
part is a group with a heading one level below the section's. A collapsible
section puts one button with `aria-expanded` and `aria-controls` inside its
heading, and focus stays on that button. When a parent closes the section while
focus is inside it, focus returns to the button. The loading state is a status
region, and the error state is an alert. A tone never carries meaning alone.
The copy button names its field, such as "Copy Customer number", and announces
"Copied". A group and an area are regions named by their heading. A collapsible
area's chevron is a button with `aria-expanded`, `aria-controls`, and the
name "Show Stack 2" or "Hide Stack 2"; the head's free space toggles too, for
the pointer. A fact group's pencil is named "Edit Bank".

## Runtime

`Section`, `Section.Part`, and `Field` render on the server. A collapsible
section and the copy button need the browser only for the interaction. Their
appearance comes from `@k2b/ui/styles.css` below the nearest `.k2b-ui` scope.

## Example

```tsx
<div class="customer-file-grid">
  <Section
    size="md"
    icon="ti ti-id"
    title="Details"
    footer={
      <Button size="sm" variant="secondary">
        <i class="ti ti-pencil" aria-hidden="true" />
        Edit all
      </Button>
    }
  >
    <Section.Part title="Contact">
      <Field label="Mobile" value="+49 151 2345 6789" copy />
      <Field label="Email" value="marlene.hofbauer@example.org" kind="email" copy />
    </Section.Part>
    <Section.Part title="Note">
      <Field label="Pickup" layout="stack" value="Picks up on Saturdays." />
    </Section.Part>
  </Section>
  <Section size="md" icon="ti ti-chart-bar" title="Reports" restricted="Only with permission">
    <StatGrid columns={3}>…</StatGrid>
  </Section>
  <Section size="md" icon="ti ti-id-badge-2" title="ID card" tone="warning" meta="Expires soon">
    <Field label="Valid until" value="11/2026" />
  </Section>
  <Section size="md" icon="ti ti-paperclip" title="Documents" state="error" errorMessage="Documents could not load." onRetry={reload} />
</div>
```
