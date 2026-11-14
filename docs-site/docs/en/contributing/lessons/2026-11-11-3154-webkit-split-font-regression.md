### Bisect font assets when browser actions repeatedly time out

- **What happened:** The grouped dependency update repeatedly timed out in WebKit Dashboard edit/add clicks and loading-state checks before reaching the limit and geometry assertions.
- **Root cause:** The package bisect isolated Tabler webfont 3.50.0: keeping every other update and pinning 3.48.0 passes the three affected tests; replacing only the generated font assets with 3.50.0 reproduces the click timeout. The update changes one font face into 48; the Dashboard fixture serves only the first font file. The precise browser blocking mechanism still needs profiling in #3165 and #3166.
- **Error class:** Dependency asset changes can stall browser interactions and appear as unrelated test flakes.
- **Guard:** The existing Dashboard browser limit, built-in frame-fit, and German interaction tests remain unchanged and gate future adoption; the dependency policy retains 3.48.0 until split-font delivery and rendering are verified.
