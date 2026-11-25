---
thumbnail: content
---

# Content

What people read and look at: reading text, a key or code to copy, files and media, and drawings such as a plan, a map or a chart. Text takes a type role, reading text is `Prose`, files are `Tiles`, and everything drawn stands in a `Canvas`.

## A page to read

A guide of Warenfluss: the title and the one deed "Bearbeiten" in the head, the text as Markdown in `Prose`, a device key to copy, the attachments as tiles and a plan of the yard in a `Canvas`. Switch the state: empty, loading and failed stand where the text would stand, and the head stays.

<Example recipe="content" height="560" default="Text" />

## Files as pictures, dragged onto folders

The grid view of Files: each file a tile with its picture in a box of a fixed shape, as large as the person chose (`pictures`, kept in the address). The symbol of its kind stands in the box while the picture loads, when it fails and when there is none, so nothing moves. The grid is one Tab stop: arrows go to the nearest tile, Space selects, Enter opens. A tile, or all selected ones, drags onto a folder of the grid or of the sidebar's tree (`drag`, one `scope`); a closed folder the pointer rests on opens, a folder that does not take them says so, and a place at the bottom says "Hier loslassen: nichts passiert". Files from the computer drop onto a folder (`onFiles`). Dragging is a shortcut: give each tile a menu entry "Verschieben nach …" for keys and touch, and move nothing before `onDrop`.

<Example recipe="file-grid" height="560" default="Medium" />

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

### Tiles

Like things to press, such as attachments and media files; each opens its file. With `pictures`, tiles with a picture box in a grid that select and drag like rows.

<Props of="Tiles Tile PictureTile" />

### DragMove

Dragging onto folders, the same for `Table` rows, picture `Tiles` and a `Nav` tree: a `scope` joins lists, `target` names folders, `accepts` says what a folder takes, `onDrop` and `onFiles` act after the drop only.

<Props of="DragMove" />

### Canvas

The one place for a drawing of its own: a plan, a map, a chart. Inside it CSS is free, and the rules do not measure it.

<Props of="Canvas" />

## Not in v2 yet

- Writing Markdown in place: the editor of `@k2b/editor` has no v2 form yet. Open it behind the deed "Bearbeiten".
- A code block with highlighting, and an image or video viewer.
- A chart with `v2.css` alone: without the `@k2b/ui` stylesheet and a `.k2b-ui` ancestor it has no size.
- A loading or failed state as high as a drawing: `Loading` and `Failed` hold rows, so the page moves while a chart loads.

Until they ship, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Put reading text in `Prose`, with the text as `markdown` when it comes as Markdown.
- Give a key or an ID `mono` and `copy` in `Facts`.
- Stand a drawing in a `Canvas` with a `label` and a `height`, directly in its `Section`.
- Show `Empty` in place of a chart that has no data.

### Don't

- Set a font size for text; pick its type role.
- Render a user's Markdown or HTML yourself with `innerHTML`.
- Wrap a `Canvas` in a plain element or make it the root of a component.
- Draw your own frame or line around a chart.

## Next

[Whole screens](/en/ui/v2/screens)
