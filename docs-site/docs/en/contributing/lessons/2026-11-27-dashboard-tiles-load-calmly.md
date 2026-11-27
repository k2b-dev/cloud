### Every dashboard tile said "Loading…" with a spinner until its app answered

- **What happened:** The dashboard loads its widgets in the browser after hydration. That is an agreed exception to server-loaded first views, as long as nothing shifts. While they loaded, every tile showed a spinner and the words "Wird geladen …", so a fresh visit opened as a wall of loading messages, against the v2 rule of no loading indicators on first render.
- **Root cause:** The loading state reused the generic `Placeholder` with `state="loading"` and a title, made for a panel that has nothing else to show. A tile already shows its frame, title and app icon from the catalog before its app answers.
- **Error class:** A loading state that announces itself on screen where the reserved frame alone already tells the person what comes there.
- **Guard:**
  - The dashboard browser test: while widgets load, no tile shows a placeholder or spinner, and no slow notice shows before its delay. The tile boxes before and after loading are identical. The summed layout shift with sources in the board is 0 (Chromium).
  - The render tests: the server markup has the loading words only for assistive technology (`aria-busy`, a visually hidden label).
