### A parser regression depends on host speed

- **What happened:** A multi-selection indentation test passed in one branch and failed in another with identical list-command code: its long fixture exhausted CodeMirror's 50 ms parse slice, so the safe no-op path ran instead of the expected edit.
- **Root cause:** A semantic regression test used the host's wall clock to choose between successful parsing and budget exhaustion.
- **Error class:** Behavior fixtures depend on parser wall time
- **Guard:** `packages/notebooks/src/frontend/lib/editor/list-commands.behavior.test.ts` retains the long, initially incomplete syntax tree and controls `Date.now()` only during the command. One case requires both selected lines to indent; another advances beyond the unchanged production budget and requires the entire source to stay unchanged. The clock is restored after each case, and the test deadline is unchanged.
