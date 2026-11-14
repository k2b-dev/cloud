# Clipboard HTML sources

These fixtures keep source HTML rather than rebuilding it from DOM nodes. Tests
assert explicit Markdown strings in `text-editor-paste.behavior.test.ts`.

- `google-docs.html`: CKEditor 5's Google Docs clipboard capture, verbatim.
  [Source](https://github.com/ckeditor/ckeditor5/blob/87d653555446917d8ab8908f91ddf7ef6ea8f51c/packages/ckeditor5-paste-from-office/tests/_data/paste-from-google-docs/bold-wrapper/simple-text/input.html).
- `word.html`: the fragment between StartFragment and EndFragment from CKEditor
  5's Word 2016 clipboard capture; the Office document header is omitted.
  [Source](https://github.com/ckeditor/ckeditor5/blob/87d653555446917d8ab8908f91ddf7ef6ea8f51c/packages/ckeditor5-paste-from-office/tests/_data/basic-styles/bold-within-text/input.word2016.html).
- `outlook.html`: the second nonempty paragraph, unchanged, from CKEditor 4's
  Outlook data-loss reproduction captured through Word 2016 and Edge.
  [Source](https://github.com/ckeditor/ckeditor4/blob/1b8366c446f6c6084dd4c7dd09633d530454f552/tests/plugins/pastefromword/generated/_fixtures/Tickets/16817SampleDocForDataLossBug/word2016/edge.html).
- `apple-notes.html`: Pen's verbatim browser paste capture from Apple Notes 4.13
  on 2026-09-23, including the Cocoa HTML Writer header.
  [Source](https://github.com/input-systems/pen/blob/442a375094b57c20ee8e0b5f740c36fe48d7c0ff/packages/extensions/interop/src/html/import/__tests__/pasteCorpus/apple-notes/clipboard.html).
- `web.html`: Substance's verbatim Edge-on-Windows clipboard reproduction
  copied from Wikipedia, including its page wrappers and fragment comments.
  [Source](https://github.com/substance/substance/blob/d8dab972b8e06931f03a33b33a4e3fbd53cb2a7d/test/clipboard/browser-windows-edge-annotated-text.html).

The small inline cases in the test cover nested Docs lists, literal Markdown,
multiple paragraphs per item, links, code, limits and image removal separately.
