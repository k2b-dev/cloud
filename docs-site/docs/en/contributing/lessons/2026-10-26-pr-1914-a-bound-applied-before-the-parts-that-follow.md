### A bound applied before the parts that follow

- **What happened:** The Links graph around a page capped its pages at 400, then added every page's way up the tree; 400 linked pages deep in their own branches returned about 20,000 nodes, and a depth cap left parents missing.
- **Root cause:** The graph capped linked pages before adding their ancestors, so the final graph exceeded the intended bound.
- **Error class:** A bound applied before the parts that follow
- **Guard:** Test: Notebooks `graph-around.integration.test.ts` builds those tree shapes and requires the bound with every way up whole. Convention: count everything a response adds toward its bound.
