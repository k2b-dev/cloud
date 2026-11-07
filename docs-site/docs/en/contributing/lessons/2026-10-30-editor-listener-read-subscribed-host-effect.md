### A CodeMirror listener read a signal and subscribed the host's dispatching effect to every update

- **What happened:** With the note editor on the new `@k2b/editor` handle, the Notebooks `sync-ended` behavior tests hung: one test ran more than 30,000 editor updates and then timed out, before the change reached `main`.
- **Root cause:** The handle's update listener compared `update.state` with its `state()` signal before writing it. CodeMirror runs listeners inside `dispatch`, and the comments panel dispatches from a Solid effect. The read inside that dispatch made the effect depend on `state()`, so each update re-ran the effect, whose dispatch made the next update.
- **Error class:** Code that runs inside another component's dispatch, such as a CodeMirror listener or facet, reads a Solid signal and becomes a dependency of the caller's effect.
- **Guard:** Listeners of the handle only write signals (`packages/editor/src/editor-state.ts`). `building-blocks.behavior.test.tsx` › "a host effect that dispatches to the view does not run again on every editor update" fails with a stack overflow without the fix.
