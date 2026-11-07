### The Book icon in the note toolbar read smaller than its neighbours

- **What happened:** In the Notebooks editor toolbar, the Book icon showed at 12 px while Comments, the detail panel toggle and the formatting icons showed at 14 px.
- **Root cause:** The `@k2b/editor` toolbar sized only its own icons through a `text-sm` class on each `<i>`. Controls a host puts into the toolbar's start and end slots had to repeat that class, and the Book link did not.
- **Error class:** A shared component's visual size is set per call site instead of by the component, so one call site that forgets it looks different.
- **Guard:** The toolbar marks its root with `data-k2b-editor-toolbar` and its stylesheet sizes every control icon inside it, host slots included. `EditorToolbar.browser.test.ts` checks that every control icon in the Notebooks toolbar is 14 px.
