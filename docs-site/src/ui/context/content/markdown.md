# Markdown content

`MarkdownView` renders Markdown safely by default with shared prose styles. `MarkdownEditor` owns interactive Markdown editing. The caller owns the Markdown source and persistence.

## Use Markdown content

Use `MarkdownView` for notes, descriptions, comments, help, and generated content whose source is Markdown.

Use `MarkdownEditor` when the same surface also edits Markdown. Use the editor's dedicated component page for its full completion, save, and input API.

## Import

```tsx
import { MarkdownEditor, MarkdownView, renderSafeMarkdown } from "@k2b/ui";
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

The component does not impose a reading width. The parent owns width, scrolling, and surrounding layout.

Set `headingScale` to `"compact"`, `"normal"`, or `"large"`. Compact headings fit embedded content such as comments and dialogs, normal is the default prose hierarchy, and large gives standalone pages a stronger hierarchy. The scale changes presentation only; Markdown heading levels remain intact. Use `class` for other context-specific text sizing.

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
