# Section and Field

`Section` is one topic of an object: an icon, a title with its count or state,
at most one control, and its content. On a full page, such as a customer file,
every section is a card with the light 1 px frame of `Paper`, on white ground
and without a shadow. In a detail panel the same component stands flat, and the
panel frames it. `Section.Part` divides a section into sub-topics without a
frame of its own, and `Field` shows one value with its label.

## Use Section

Give each topic of a page its own `Section` and lay the sections out with the
page's own grid. Use `size="md"` on pages and keep the default `size="sm"` in
panels and other narrow columns. Order the sections by use: what people work
with first, context later.

A section never holds a card. A section inside another section, a
`DetailPanel.Group`, a summary, `Paper`, a dialog, a panel dialog, or a settings
section loses its own frame automatically, so cards never nest. Divide one topic
with `Section.Part`, not with a nested section. Do not wrap a section in `Paper`
or add an application border, shadow, or padding around it.

Inside `DetailPanel` a section stands flat because the panel sets its default
`frame` to `"none"`. Leave `frame` unset there. Pass `frame="none"` only where a
host outside a panel frames its sections itself.

### Tones

A tone is named after a status token and colors the frame, the title, and the
icon, never the fill: `neutral` (the default), `success`, `warning`, `danger`,
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
keeps the neutral frame by default, so green stays reserved for success.

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
disclosure button. On a card it fills the card's top on hover; flat, hover
colors the title and chevron. Pass `summary` for one line that says what a
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

## Import

```tsx
import { Field, Section } from "@k2b/ui";
```

## Properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `title` | `JSX.Element` | required | Names the topic. |
| `icon` | `string` | none | Icon class, in a 20 px column (`sm`) or a neutral 28 px tile (`md`). |
| `size` | `"sm" \| "md"` | `"sm"` | `sm` for panels and narrow columns, `md` for page topics. |
| `frame` | `"line" \| "none"` | `"line"`, `"none"` in a `DetailPanel` | Draws the light card frame. |
| `tone` | `"neutral" \| "success" \| "warning" \| "danger" \| "info" \| "ai"` | `"neutral"` | Colors the frame, title, and icon by status. |
| `restricted` | `string` | none | Lock and words for restricted visibility. |
| `count` | `number` | none | Count chip after the title; `0` reads "None yet". |
| `meta` | `JSX.Element` | none | Short state after the title, such as "2 of 4 done". |
| `description` | `JSX.Element` | none | One quiet line below the title. |
| `actions` | `JSX.Element` | none | Exactly one control at the end of the heading. |
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

## Accessibility

A section is a `section` region named by its heading; `restricted` words are
part of that name, so a screen reader hears "Reports, Only with permission". A
part is a group with a heading one level below the section's. A collapsible
section puts one button with `aria-expanded` and `aria-controls` inside its
heading, and focus stays on that button. When a parent closes the section while
focus is inside it, focus returns to the button. The loading state is a status
region, and the error state is an alert. A tone never carries meaning alone.
The copy button names its field, such as "Copy Customer number", and announces
"Copied".

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
