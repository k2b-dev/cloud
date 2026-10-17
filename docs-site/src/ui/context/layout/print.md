# Browser printing

Every application view either prints its content (mark it with `data-print-region`) or shows the print fallback with the app's export hint (Cloud Layout `printHint`).

## Use browser printing

Use the `@k2b/ui` stylesheet contract for complete readable content. For an app overview, graph, or virtualized list without a printable copy, supply the fallback.

## Import

The attributes need no JavaScript import. Load `@k2b/ui/styles.css` through your application's existing stylesheet.

## Choose what prints

Add `data-print-region=""` to the element that holds the complete readable content. Several regions may print together. Mark a region only when its content is ready; a virtualized editor or list cannot supply a whole document from its visible rows. A region prints even when an ancestor is hidden on screen, so set the attribute only on the view that is currently shown, not on inactive tab panels or cached views.

## Example

```tsx
<article data-print-region="">
  <h1>{note.title}</h1>
  <button class="print:hidden" onClick={edit}>Edit</button>
  <NoteContent note={note} />
</article>
```

With a region, everything else inside `.k2b-ui` is hidden on paper, including Cloud's app bar, header, page trail, sidebars, and detail panels. A region inside a detail panel still prints. Ancestors become plain blocks without fixed height, clipping, or padding; workspace and scroll-area containers inside a region grow to their full content, and a `ScrollArea` positioned to fill an overflow-hidden frame joins the flow. A custom scroll container of the application (`overflow-auto` with a fixed height) still clips; release it with `print:` utilities or keep it out of the region. Use Tailwind `print:hidden` for controls **inside** a region. Links are underlined; their destination is not appended.

## Provide an export hint

`data-print-fallback=""` is always hidden on screen. When no region exists, only the fallback prints. Cloud `Layout` supplies it in regular and focus mode. Set `printHint` to the application's final localized sentence explaining its export or how to open printable content:

```tsx
<Layout c={c} printHint={t.printHint}>
  <Overview />
</Layout>
```

Without either attribute, `AppWorkspace` prints its Main at full length and hides its sidebar, resize handles, detail panels, bottom drawer, head toggle, toasts, and dialogs. A standalone application can supply its own fallback under `.k2b-ui`.

## Accessibility

Keep semantic headings, link text and image descriptions in the printed content. Screen-hidden print copies must not expose duplicate controls or focus targets.

## Runtime

The CSS works on server-rendered HTML before JavaScript loads and does not change screen geometry. Transitions and animations stop on paper, so a panel that animates its display is already hidden when the page prints. A client-owned print copy renders on `beforeprint` or when print media starts, not while the person works: it adds its region attribute only after that render, removes it on disposal, and falls back to the export hint when its renderer has not loaded yet.

## Check paper and screen

Use browser print emulation to check that every row prints beyond the first viewport and no ancestor clips it. Compare screen geometry with and without the region attribute; the fallback must have no box on screen. Until [#1274](https://github.com/k2b-dev/cloud/issues/1274) makes dark a screen-only theme, regions and fallbacks on dark pages print as near-black ink on white paper. Images keep their pixels, so a diagram drawn in the dark theme prints dark.
