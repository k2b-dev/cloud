### Markdown headings in the text editor were underlined

- **What happened:** In every `@k2b/ui` text editor without its own highlight style, such as the public Notes site and the Mail composer, Markdown headings were underlined. The heading lines already have their own size and weight, and the underline made them look like links.
- **Root cause:** The built-in presentation in `packages/ui/src/text-editor/engine.ts` used CodeMirror's `defaultHighlightStyle` as its fallback. That style underlines `tags.heading`. Notebooks did not show it because its own theme replaces the fallback.
- **Error class:** A library's default style adds a visual rule that the component never chose.
- **Guard:** The text editor builds its highlight style from the default without the heading rule. `packages/ui/src/text-editor/text-editor.browser.test.ts` ("headings show their size and weight without an underline") checks that no element in a heading line is underlined.
