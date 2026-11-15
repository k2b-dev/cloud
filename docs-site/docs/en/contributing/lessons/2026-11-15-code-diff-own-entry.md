### A component nobody on the page uses still filled its island's first download

- **What happened:** After the Code page gained its code tab, the web Assistant's static island closure came within a few bytes of its budget, although the Assistant never shows `CodeDiff`. Loading the code tab lazily on the Code page changed nothing.
- **Root cause:** With chunk splitting, Bun places a module the root entry of `@k2b/ui` re-exports into the chunks every importing island loads first, as soon as any entry of the build uses it. `CodeDiff` was re-exported from the root entry and used by Administration and the Code page, so it travelled with the Assistant.
- **Error class:** A large component in a shared barrel entry costs every island that imports the barrel, whatever each island renders.
- **Guard:** `CodeDiff` has its own entry, `@k2b/ui/code-diff`, like `@k2b/ui/panes`; the `island-bundles` rule keeps measuring the Assistant (3 384 102 B before, 3 373 484 B after), and a render test keeps `?tab=code` rendered on the server.
