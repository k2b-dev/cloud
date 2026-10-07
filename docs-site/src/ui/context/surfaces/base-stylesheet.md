# Base stylesheet

`@k2b/ui/base.css` styles a plain HTML page without classes. Headings, lists,
tables, forms, buttons, `<details>`, `<dialog>`, and `<progress>` look like the
components in light and dark. A few short helper classes cover layouts that
HTML has no element for.

The stylesheet needs no JavaScript and no Solid. It is meant for pages that
are written as HTML, such as generated reports, small tools, and documents
that are printed or rendered to PDF.

## Use the base stylesheet

Use it for a whole page written in semantic HTML. Use the components and
`styles.css` for Solid applications; the two stylesheets do not depend on each
other and are not meant for the same page.

Unlike `styles.css`, the base stylesheet styles the document itself: `html`,
`body`, and every element on the page. Load it only into a page or frame that
it owns.

## Import

```css
@import "@k2b/ui/base.css";
@import "@k2b/ui/fonts/plex.css"; /* optional: IBM Plex instead of the system font */
```

Or read the file as text and put it into a `<style>` element, for example in
an `iframe` `srcdoc` or in HTML that is rendered to PDF.

## Cascade

Every rule and token sits in `@layer k2b-base`. Any rule of the page outside a
layer wins, whatever its specificity, so page CSS never fights the base
stylesheet.

## Theme

`<html data-theme="dark">` switches to the dark theme; without the attribute
the page is light. Changing the attribute switches live. Colors use the same
token names and values as the components, for example `--k2b-surface`,
`--k2b-surface-muted`, `--k2b-text`, `--k2b-text-muted`, `--k2b-border`,
`--k2b-action`, `--k2b-action-solid`, `--k2b-focus-ring`,
`--k2b-{info,success,warning,danger}-{surface,text}`, `--k2b-radius-control`,
`--k2b-radius-surface`, `--k2b-font-sans`, `--k2b-font-mono`, and
`--stdlib-chart-c1` to `--stdlib-chart-c8`. Use these tokens in page CSS
instead of fixed colors or `prefers-color-scheme`.

## Elements

| Area | Behavior |
| --- | --- |
| Page | `body` carries the padding (1.5rem, 1rem on phones) and a reading width of 72rem, so pages without `<main>` look the same. Text is 15px with a line height of 1.55. |
| Spacing | Siblings are spaced by whitespace from above: 1rem in a flow, 0.5rem after a heading, 2rem before `h2` and `h3`, 2.5rem between top-level sections. No lines or frames separate sections. |
| Type | `h1` 1.5rem, `h2` 1.25rem, `h3` 1.0625rem, `h4` to `h6` body size, all semibold. `small`, `figcaption`, and `caption` are muted. |
| Lists | A list item with a checkbox, directly or inside its `label`, is a checklist row without a bullet. The label grows, buttons trail, and checked items are muted and struck through. Put buttons next to the label, never inside it. |
| `dl` | A key/value grid for detail views. |
| Tables | Full width, small muted header, no row lines, a hover surface, cells centered vertically. A table in `<figure>` scrolls sideways instead of widening the page. |
| Forms | A `label` sits above its field, or beside a checkbox or radio. Fields use a muted surface, show a border on hover and an inset focus ring, and mark `:user-invalid`. `fieldset` has no frame. |
| Buttons | Buttons are calm. The submit button of a form and `.primary` are filled; `type="button"` and `value="cancel"` stay calm. `aria-busy="true"` shows a spinner without changing the size. |
| Feedback | `role="alert"` is an error surface and hidden while empty. `role="status"` and `<output>` are muted text without a surface. `data-tone` (`info`, `success`, `warning`, `danger`) colors the surface of alerts and the text of status messages. |
| Navigation | Buttons or links in a `<nav>` are tabs or filters; `aria-pressed`, `aria-current`, or `aria-selected` marks the active one. |
| Disclosure and dialog | `details` shows a chevron. `dialog` is the only floating surface; a `footer` or `menu` inside it aligns its buttons at the end. |
| Charts | The SVG of an `@k2b/stdlib` chart inside `.k2b-chart` > `.k2b-chart__svg`, the markup of the `Chart` component, uses the chart tokens. |

## Helper classes

| Class | Behavior | Markup |
| --- | --- | --- |
| `.row` | A wrapping flex row aligned at the bottom; fields grow. With a heading inside it is a header: the title first, the actions at the end, centered. | `<form class="row"><label>Name <input></label><button>Add</button></form>`, `<header class="row"><h1>Expenses</h1><button type="button" class="primary">Export</button></header>` |
| `.grid` | Columns of at least 14rem with a 1rem gap, for fields; key figures use columns of at least 8rem. | `<div class="grid"><label>…</label><label>…</label></div>` |
| `.stat` | A key figure: a small muted label, the value large beneath it, without a surface. | `<div class="stat"><span>Revenue</span><strong>€12,400</strong></div>` |
| `.scroll` | Scrolls sideways like a `<figure>` around a table. | `<div class="scroll"><table>…</table></div>` |
| `.tag` | A status tag; `data-tone` colors it. | `<span class="tag" data-tone="success">Paid</span>` |
| `.danger` | A destructive action, red without a surface. In a list or table row it stays muted until the row is hovered or holds the focus. | `<button type="button" class="danger">Delete</button>` |
| `.muted`, `.num`, `.primary`, `.sr-only` | Muted text, right-aligned tabular numbers, a filled button, and text only screen readers announce. | `<td class="num">€89.90</td>` |

`.row`, `.grid`, and `.stat` take the flow spacing from their children. A
custom flex or grid layout sets `gap` and turns the flow spacing off with
`> * { margin: 0 }`; otherwise gap and spacing add up.

## Accessibility

Use semantic elements, so the page works without classes: real buttons,
labels around or linked to their fields, `th` for table headers, and
`role="alert"` or `role="status"` for messages. Give an icon-only button a
name with `aria-label` or a `.sr-only` text.

Focus shows as a 2px outline that never moves the layout. On touch screens,
buttons, fields, `summary`, and navigation items are at least 2.75rem high.
The stylesheet honors `prefers-reduced-motion` and prints on white.

## Runtime

The stylesheet is static CSS. It needs current engines for `light-dark()`,
`:has()`, and `:user-invalid`, and it reads no storage or script state. The
`data-theme` attribute is the only switch.

## Example

```html
<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <link rel="stylesheet" href="/assets/k2b-ui/base.css">
  </head>
  <body>
    <main>
      <header class="row">
        <h1>Tasks</h1>
        <button type="button" class="primary">Export</button>
      </header>
      <form class="row">
        <label class="sr-only" for="title">New task</label>
        <input id="title" name="title" placeholder="New task">
        <button>Add</button>
      </form>
      <ul>
        <li>
          <label><input type="checkbox"> Send the invoice</label>
          <button type="button" class="danger" aria-label="Delete Send the invoice">✕</button>
        </li>
      </ul>
      <p role="status">1 open</p>
    </main>
  </body>
</html>
```

The page copies `node_modules/@k2b/ui/dist/base.css` to its own assets, or
its bundler resolves `@import "@k2b/ui/base.css"`.
