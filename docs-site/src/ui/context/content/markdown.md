# Markdown content

`MarkdownView` renders Markdown safely by default with shared prose styles. `MarkdownEditor` owns interactive Markdown editing. The caller owns the Markdown source and persistence.

## Use Markdown content

Use `MarkdownView` for notes, descriptions, comments, help, and generated content whose source is Markdown.

Use `MarkdownEditor` when the same surface also edits Markdown. Use the [MarkdownEditor reference](/en/ui/input/markdown-editor) for its completion, save, and input API.

## Import

```tsx
import { MarkdownEditor, MarkdownView, renderSafeMarkdown } from "@k2b/ui";
```

Renderers with their own Markdown pipeline import the info-block and link
helpers:

```ts
import { markdownInfoBlocks, renderMarkdownInfoBlock, scanMarkdownInfoBlock } from "@k2b/ui";
import { markdownLinkReference, markStandaloneLinks, renderMarkdownLink } from "@k2b/ui";
```

## Render Markdown

Pass untrusted Markdown directly:

```tsx
<MarkdownView markdown={markdownSource} />
```

Raw HTML and unsafe URL protocols are escaped. If an application already has
sanitized, trusted HTML, cross the boundary explicitly with
`trustedHtml={html}`. Never pass user-controlled HTML through that property.

Use `renderSafeMarkdown(markdownSource)` only when a non-component boundary
needs the same escaped HTML output. `MarkdownView` remains the normal UI API.

### Control resource loading and navigation

For isolated or offline content, set `allowImages={false}` to render image alt
text without requesting the image resource. Images remain enabled by default.
An optional `linkProtocols` allowlist contains protocol names including the
colon, such as `["https:", "http:", "mailto:"]`; relative links are checked
against HTTPS. `linkTarget="_blank"` adds `rel="noopener noreferrer"`.
These options also work with `renderSafeMarkdown(source, options)`. They apply
to Markdown rendering only; `trustedHtml` already crosses an explicit trust
boundary and bypasses the renderer.

Embedded components such as `NoticeCard` keep their own inner spacing and sit
one paragraph apart from the surrounding prose; ordinary Markdown paragraphs
retain the standard prose spacing.

### Info blocks

Info blocks render as the same calm notice as the
[`NoticeCard`](/en/ui/feedback/blocks) component: a light tint of the tone,
neutral text, and no icon.

```md
:::warning Before deleting
Export the data first. **Deleting cannot be undone.**
:::
```

- The types are `note`, `info`, `success`, `warning`, and `danger`, in any
  letter case.
- The opening line holds `:::`, the type, and an optional plain-text title.
  The title is the visible heading. Without a title, screen readers hear the
  type name in the render locale, such as "Warning" or "Warnung"; sighted
  readers see only the tint, so start the text with a label when the type
  matters.
- The block ends at a line holding only `:::`, indented no deeper than the
  opener. A `:::` inside code, a list, a quote, or an HTML block does not end
  it.
- The body is ordinary Markdown with the same escaping and link rules as the
  rest of the view. Raw HTML stays text.
- Blocks work at the top level of a document. Inside a list, a quote, or
  another block, and without a closing line, the text stays as written.

This grammar and markup are one implementation: `MarkdownView` and every
renderer built on the exports below produce the same blocks. A renderer may be
stricter about one case and mark a block without its closing line as invalid,
so the author sees what to fix.

A renderer with its own `marked` instance adds `markdownInfoBlocks({ locale })`;
its body still runs through that instance's renderer and sanitizer. Locales
that share a UI message catalog get the same extension object, so a server
that caches one `marked` instance per extension keeps a bounded cache whatever
locale a request sends. A renderer that scans source lines itself uses
`scanMarkdownInfoBlock(source)` for the block's type, title, body, and extent,
and `renderMarkdownInfoBlock({ type, title, bodyHtml, locale })` for the
markup. The scanner accepts any line endings; `length` counts the source as
given, and `body` uses `\n`. `bodyHtml` crosses a trust boundary: the caller
sanitizes it. `renderSafeMarkdown(source, { locale })` names untitled blocks
in that locale; `MarkdownView` passes the inherited render locale.

Prose stays flat on the surrounding surface. Links follow
[Links and references](#links-and-references). Inline code and fenced code blocks are text on a light fill
without a frame; quotes are marked by a rule at their start edge. Inside a
tinted group such as a dialog section, code fills follow
`--k2b-field-surface`, so they stay visible. Any other tinted host sets
`--k2b-field-surface` to its base surface, as it does for field wells.
Long words and URLs wrap instead of widening the page.

### Links and references

Every rendered link is one of two kinds, and the link destination decides
which:

- A **reference** points to content of the host: any relative URL. `#anchor`
  is a heading of the same document; a relative URL whose last path segment has
  a file extension is a file; any other relative URL is a page. A reference is
  a calm pill: a neutral fill, the text in the prose colour, and an icon whose
  colour names the type. PDFs are red, images violet, design files orange,
  notes blue-gray, headings and pages gray, and tasks green. Any other file
  shows the icon of its file family in the muted text colour.
- A **web link** (an absolute or protocol-relative URL) is prose text with a
  thin underline in the link accent and a small ↗. A **mail link** (`mailto:`,
  `tel:`) is the same without the arrow.

A reference's accessible name starts with its type in the render locale, as
in "PDF: Brand-2026.pdf" or "Überschrift: Akzentfarbe". The type names are
PDF, Image, Design file, File, Note, Heading, Task, and Page.

Hover darkens only a pill's fill and strengthens only a web link's underline;
keyboard focus draws the shared focus outline. No state changes font weight,
padding, or borders, so no text moves. A long name wraps inside its pill,
which repeats its padding and rounded corners on every line. In forced-colour
modes, where the fill disappears, pills are underlined.

The link accent is the optional host hook `--k2b-link-accent`; it defaults to
`--k2b-action`. The reference colours are the tokens `--k2b-reference-surface`,
`--k2b-reference-surface-hover`, `--k2b-reference-pdf`, `--k2b-reference-image`,
`--k2b-reference-design`, `--k2b-reference-note`, `--k2b-reference-heading`,
and `--k2b-reference-task`, with light and dark values. On the default
surfaces, pill text, muted labels, and sizes keep at least 4.5:1 and icons at
least 3:1, also on the hover fill.

A renderer that knows more about a link than its URL renders it with
`renderMarkdownLink({ href, html, reference, standalone, locale })`. The
`reference` names the kind (`file`, `note`, `heading`, `task`, or `page`) and
optionally the file's name, which decides its type, a formatted `size`, and
for a heading in another document that document's title, shown first as
"Notes › Heading". A file shows its size only when the link stands alone on
its line, as in a list of files; `markStandaloneLinks(token, set)` marks those
links from `walkTokens` of a renderer with GFM line breaks. Without a
`reference`, the helper renders a web or mail link. `markdownLinkReference(href)`
is the classification `MarkdownView` uses. `html` crosses a trust boundary:
the caller sanitizes it, and a sanitizer keeps the `class`, `aria-label`,
`data-reference`, and `data-link` attributes.

### Highlight known inline tokens

Pass exact `inlineTokens` when an authoring preview needs to distinguish known
variables or placeholders from ordinary prose:

```tsx
<MarkdownView markdown="Hello @auth.name" inlineTokens={["@auth.name"]} />
```

The safe renderer decorates matching standalone text tokens while parsing the
Markdown. It does not rewrite rendered HTML, inline code, code blocks, link
destinations, or trusted HTML. Callers must provide the complete allowlist;
unknown text stays ordinary Markdown. Use
`renderSafeMarkdown(source, { inlineTokens })` at non-component boundaries.

The component does not impose a reading width. The parent owns width, scrolling, and surrounding layout. A `FileView` with `variant="plain"` caps Markdown at a reading measure of 72 characters.

Set `headingScale` to `"compact"`, `"normal"`, or `"large"`. Compact mode uses smaller headings and tighter paragraph spacing for embedded content such as comments and dialogs. Normal is the default prose hierarchy, and large gives standalone pages a stronger hierarchy. The scale changes presentation only; Markdown heading levels remain intact. Use `class` for other context-specific text sizing.

## Editing and preview

Keep the Markdown string as the source of truth and pass the same value to the
editor and preview. Saving still belongs to the parent mutation or form.

## Accessibility

Rendered Markdown must preserve a useful heading order and descriptive link text. Do not use `headingScale` to repair an incorrect document structure.

Give standalone editors an `aria-label` when no visible label references them.
Preview and edit modes need visible names when both are present.

## Runtime

`MarkdownView` is server-renderable and needs no hydration for ordinary Markdown.
Optional client enhancements belong to the hydrated host.

`MarkdownEditor` and a reactive live preview require hydration. The initial preview can still be rendered on the server from the initial Markdown value.

## Example

```tsx
const [source, setSource] = createSignal("# Release notes");

<div class="app-markdown-split">
  <MarkdownEditor
    value={source()}
    onValueChange={setSource}
    aria-label="Release notes Markdown"
    fill
  />

  <section aria-label="Release notes preview">
    <MarkdownView markdown={source()} />
  </section>
</div>;
```

## Tables

Markdown tables omit the header row when all header cells are blank. Partially
filled headers stay visible. Tables are hairlines on the reading surface: no
frame or fill, a stronger line under the header, and a fine line between rows,
so a cell that wraps still belongs to one row. The text of the first and last
columns lines up with the surrounding prose. Header cells align with their
column: at the start by default, or with the column's GFM alignment (`:-:`,
`--:`). Body cells use tabular figures, so numbers line up. Inline formatting
is preserved.

The table reaches 0.5rem past the prose on both sides, and every cell pads its
text by 0.5rem, so columns sit 1rem apart. The lines therefore run 0.5rem past
the outer text. Cloud's Markdown tables use the same geometry for their hover:
a row's fill and a column's band are exactly as wide as the lines and reach
0.5rem past the text on every side. Wide tables scroll within a
keyboard-focusable container, including that extra 0.5rem. Its focus ring sits
inside its edge, in the space beside the text.

A table at the start of the content keeps the 0.5rem above its header, so its
header text starts that much lower than a paragraph would.

A host that scrolls or clips its content needs at least 0.5rem of inline
padding around a Markdown table. Without it, a scrolling host scrolls sideways
by that amount, and a clipping host cuts the line ends. If the host is flush
with its surroundings, pair the padding with an equal negative margin, so the
text stays in place. The bodies of `prompts` dialogs, `FileView` previews and
excerpts of a document, and the clamp of a collapsed `MessageRow` already do
this.
