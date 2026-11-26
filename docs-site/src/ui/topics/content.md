---
thumbnail: content
---

# Content

What people read and look at: reading text, a key or code to copy, files and media, and drawings such as a plan, a map or a chart. Text takes a type role, reading text is `Prose`, code is a `CodeBlock`, files are `Tiles`, and everything drawn stands in a `Canvas`.

## A page to read

A guide of Warenfluss: the title and the one deed "Bearbeiten" in the head, the text as Markdown in `Prose`, a device key to copy, the attachments as tiles and a plan of the yard in a `Canvas`. Switch the state: empty, loading and failed stand where the text would stand, and the head stays.

<Example recipe="content" height="560" default="Text" />

## Code to read and copy

The admin page of a gateway: a private key hidden until "Zeigen", a config with line numbers and a switch for long lines, a command and a TypeScript snippet, each a `CodeBlock` in its `Section`. Copy says "Kopiert" in a toast; copy and download work while the key is hidden, and the hidden key keeps the shape of its signs, so nothing moves when it shows. Hidden means hidden from eyes: the key still travels to the browser in the page's data, so send it only to a person who may have it. Switch to the log: 2,000 lines with one of 10,000 signs show 200 lines and "Alles zeigen", and the long line scrolls inside its block, never the page.

<Example recipe="code" height="640" default="Hidden key" />

## A chart in a screen

A chart is the `Chart` of `@k2b/ui` (data types in `@k2b/ui/charts`, every kind in [Charts](/en/ui/charts)) in a `Canvas` with a height, directly in its `Section`. The chart fills the `Canvas`; with no data, `Empty` stands in place of the `Canvas`.

```tsx
<Section icon="chart-line" title="Einlieferungen je Monat">
  <Canvas label="Einlieferungen je Monat, Juni bis November" height={240}>
    <Chart kind="line" style={{ height: "100%" }} series={series} xAxis={{ format: (x) => months[x] ?? "" }} />
  </Canvas>
</Section>
```

Inside a v2 screen a chart speaks v2: the v2 font, its words in the meta role (12/16), the v2 inks and lines, the surface between slices in both themes, its legend on the text edge, and a tooltip like a v2 overlay. A chart needs the `@k2b/ui` stylesheet and a `.k2b-ui` ancestor, which every Cloud page has, so this page shows no live chart.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Text

Words in one of the four type roles (meta, row, body, lead); emphasis is a weight, never a size.

<Props of="Text" />

### Prose

Reading text, 14/22 with a measure of 720 px; Markdown is rendered safely, without raw HTML or images.

<Props of="Prose" />

### Facts

Values with their labels; `mono` and `copy` make a key, a token or an ID easy to read and copy.

<Props of="Facts Fact" />

### CodeBlock

Code to read and copy (a config, a key, a command), monospace 12/16 with its name, copy and optional download, highlighting, line numbers, a wrap switch and a hidden secret.

<Props of="CodeBlock" />

### Tiles

Like things to press, such as attachments and media files; each opens its file.

<Props of="Tiles Tile" />

### Canvas

The one place for a drawing of its own: a plan, a map, a chart. Inside it CSS is free, and the rules do not measure it.

<Props of="Canvas" />

### Disclosure

Something that opens in place, such as the answer to a question. Its content is made only while it is open: a closed answer is not in the page, so the browser's find in page does not reach it.

<Props of="Disclosure" />

## Not in v2 yet

- Writing Markdown in place: the editor of `@k2b/editor` has no v2 form yet. Open it behind the deed "Bearbeiten".
- An image or video viewer.
- A chart with `v2.css` alone: without the `@k2b/ui` stylesheet and a `.k2b-ui` ancestor it has no size.
- A loading or failed state as high as a drawing: `Loading` and `Failed` hold rows, so the page moves while a chart loads.

Until they ship, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Put reading text in `Prose`, with the text as `markdown` when it comes as Markdown.
- Give a key or an ID `mono` and `copy` in `Facts`; put code of more than one line in a `CodeBlock` with a `label`, and a private key with `secret`.
- Stand a drawing in a `Canvas` with a `label` and a `height`, directly in its `Section`.
- Show `Empty` in place of a chart that has no data.

### Don't

- Set a font size for text; pick its type role.
- Render a user's Markdown or HTML yourself with `innerHTML`.
- Wrap a `Canvas` in a plain element or make it the root of a component.
- Draw your own frame or line around a chart.

## Next

[Whole screens](/en/ui/v2/screens)
