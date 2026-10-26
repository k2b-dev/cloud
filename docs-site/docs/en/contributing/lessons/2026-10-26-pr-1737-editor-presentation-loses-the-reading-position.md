### Editor presentation loses the reading position

- **What happened:** Switching table widgets to raw Markdown changes heights above the viewport; preserving selection alone can move the selected paragraph off screen.
- **Root cause:** Editor presentation loses the reading position.
- **Error class:** Editor presentation loses the reading position
- **Guard:** Test: Notebooks `shared-text-editor.browser.test.ts` switches both ways in a long note, preserving bytes, native selection, and the paragraph at the outer scroll area edge on desktop and phone. Reuse the existing reading-position anchor before the reactive presentation changes.
