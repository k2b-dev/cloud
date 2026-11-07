### A page carries the whole data set

- **What happened:** Every Notebooks page put the whole note tree, with every note's Markdown, into the sidebar's island props, the phone menu and the HTML; each live event fetched it again. A 20,000-page notebook sent 146 MiB per page view.
- **Root cause:** The page and navigation serialized the complete note tree and Markdown instead of querying the visible window.
- **Error class:** A page carries the whole data set
- **Guard:** Test: Notebooks `large-notebook-sidebar.integration.test.ts` opens the same pages of a 13- and a 20,000-page fixture and fails when size or time grows with the notebook; `NotebookSidebar.render.test.tsx` renders one page of a 5,000-note level.
