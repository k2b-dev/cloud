# Solid Modules

```ts
import { mutation, query, timed, hotkeys, dnd, detailPanel, localStore, clipboard, clickOutside, dropzone, a11y } from "@k2b/stdlib/solid";
```

All exports require SolidJS. Primitives that register lifecycle cleanup must be called inside a
reactive owner (component or `createRoot`); owner-independent APIs are noted explicitly.

## mutation

Async mutation controller with reactive signals, lifecycle hooks, abort, and retry.
It does not require a reactive owner.

```tsx
import { mutation } from "@k2b/stdlib/solid";

const { data, error, loading, mutate, abort, retry } = mutation.create({
  mutation: async (vars: { name: string }, { abortSignal }) => {
    const res = await fetch("/api/items", {
      signal: abortSignal,
      method: "POST",
      body: JSON.stringify(vars),
    });
    return res.json();
  },
  onBefore: (vars) => ({ optimisticId: crypto.randomUUID() }),
  onSuccess: (data) => console.log("Created:", data),
  onError: (err) => console.error("Failed:", err),
  onFinally: () => console.log("Done"),
});

mutate({ name: "New Item" });
abort();   // cancel in-flight request
retry();   // retry with same args (skips onBefore)
```

Signals: `data()`, `error()`, `loading()`, `status()`, and `settledAt()` are all reactive.

`status()` says where the mutation stands:

| Status | Meaning |
|---|---|
| `idle` | No call has ended yet and none is running. |
| `pending` | `mutate()` was called and `onBefore` is still running. |
| `loading` | The mutation function is running (`loading()` is `true`). |
| `success` | The last call succeeded. A throw in `onSuccess` keeps `success`. |
| `error` | The last call failed in `onBefore` or in the mutation function. |
| `aborted` | The last call was aborted or cancelled in `onBefore`. |

Read `status()` first: `error()` may still hold the error of an earlier call after an abort or a
`cancel()`, and `data()` keeps the last successful result.

`settledAt()` is the time of the last end (success, error, or abort) in milliseconds, `null`
before the first end. It is strictly increasing, so it changes on every end, also for two
equal results in a row. Pass `now` to use another clock, for example a frozen one in tests.
It follows the wall clock: if the clock jumps back, the value can lie in the future, so cap any
hold time computed from it (for example, show a success mark for at most 2 s).
Several views of one mutation read the same values, so they all show the same state, no
matter which of them started the call.

Signals and `status()` are updated before `onSuccess`, `onError`, `onAbort`, and `onFinally`
run, so a hook may start the next call.

### The outcome of a call

`mutate()`, `retry()`, and `run.retry()` resolve with how this call ended:
`"success"`, `"error"`, `"aborted"`, `"dropped"`, or `"superseded"` (type `MutationOutcome`).
`dropped` means the call ran nothing: another call was pending or loading, or `retry()` had
nothing to repeat. `superseded` means the call ran, but a newer call replaced it under
`concurrency: "replace"` and its result was discarded; its work may have reached the server,
and `onFinally` ran. Read the outcome after `await`, not
`error()` or `data()`: those belong to the mutation and may describe another call.

```tsx
const submit = async () => {
  if ((await save.mutate(form())) === "success") close();
};
```

A throw in `onSuccess` still rejects the Promise.

### Concurrent calls

By default (`concurrency: "drop"`), a call made while another one is `pending` or `loading`
is dropped: it runs nothing, changes no state, no hook runs (also not `onFinally`), and its
Promise resolves `"dropped"`. `retry()` and `run.retry()` follow the same rule. This also guards
hotkeys, form submits, and code that call `mutate()` directly.

One mutation shared by many rows drops a click on row B while row A saves. Give each row its
own mutation (one component per row), or use `concurrency: "replace"` when the newest call must
win.

`abort()` is always a way out and ends the call in flight at once: `status()` is `aborted`
and `settledAt()` moves synchronously, then `onAbort` and `onFinally` run. While `onBefore` is
pending, they run without a context, the hook's `signal` fires, and whatever `onBefore` returns
later is ignored. While the mutation function runs, its `abortSignal` fires so it can stop;
whatever it returns or throws later is discarded. `abort(); mutate(next)` starts `next` at
once. A hook that awaits a question checks `signal.aborted` after the `await` and stops before
any optimistic change:

```tsx
onBefore: async (item, { cancel, signal }) => {
  const confirmed = await askToDelete(item);
  if (signal.aborted || !confirmed) return cancel();
  hideFromList(item);
  return { item };
},
```

Use `concurrency: "replace"` when the newest call must win, for example autosave or search
as you type. A new call then starts anyway; when it reaches its mutation function, it becomes
the source of truth and the older run's result is discarded. The older work keeps running and
its `onFinally` still runs.

```tsx
const autosave = mutation.create({
  concurrency: "replace",
  mutation: (body: string, { abortSignal }) => api.saveDraft(body, abortSignal),
});
```

### Cancel in `onBefore`

`onBefore` receives `{ cancel }` as its second argument. `cancel()` ends the hook immediately;
the call ends as `aborted` without `onError` or `onAbort`, `onFinally` runs without a context,
`mutate()` resolves, and `retry()` does not repeat the cancelled call. Ask first, then change
optimistically, so a cancel has nothing to undo. Write `return cancel()`, so TypeScript knows
the rest of the hook runs only after a yes. Calling `cancel()` after the hook ended only throws
at that place:

```tsx
const remove = mutation.create({
  onBefore: async (item: Item, { cancel }) => {
    if (!(await askToDelete(item))) return cancel();
    hideFromList(item.id);
    return { item };
  },
  mutation: (item, { abortSignal }) => api.deleteItem(item.id, abortSignal),
  onError: (_err, ctx) => ctx && showInList(ctx.item.id),
});
```

### Retry a failed call

`onError` receives the failed call as its third argument. `run.retry()` repeats exactly that
call with its variables, also after other calls have run, which suits a "Try again" action in a
notification. A call that failed in `onBefore` runs `onBefore` again; a call that failed in the
mutation function reuses its context, like `retry()`.

```tsx
onError: (err, _ctx, run) => showError(err.message, { tryAgain: run.retry }),
```

A wrapper that forwards `onError` must pass all three arguments:
`options.onError?.(error, ctx, run)`.

`retry()` on the mutation repeats the last started call.

`onSuccess` runs after `data()` and `loading()` are updated. Errors thrown by `onSuccess` are not
stored in `error()` or passed to `onError`; `mutate()` and `retry()` reject with them. The same
holds for computations that read the mutation's signals: their errors reach the nearest Solid
error boundary or, without one, reject `mutate()`.
Errors in `onAbort`, `onFinally`, or signal readers during `abort()` also reject the
call's `mutate()` Promise; `abort()` itself returns normally, and `onFinally` still runs.

## query

Owner-local canonical reads with source changes, optional initial data, refresh,
invalidation, abort, last-good data, and infinite pagination. Queries do not share a
global cache or deduplicate requests across owners.

```tsx
import { query } from "@k2b/stdlib/solid";

const workspace = query.create({
  source: () => requestUrl(),
  initial: {
    source: props.requestUrl,
    data: props.data,
  },
  enabled: () => !dialogOpen(),
  load: async (url, { abortSignal, cause }) => {
    const response = await fetch(url, { signal: abortSignal });
    if (!response.ok) throw new Error("Could not load workspace");
    return response.json();
  },
});
```

Matching initial data suppresses the first request. Without `initial`, the current source
loads automatically after the owner mounts on the client. Server rendering never starts a
load or subscription; SSR data is optional and is passed through `initial` when available.
Source changes load automatically and keep last-good data renderable until the new source
commits. Use `isSameSource` when source identity needs semantic comparison instead of
`Object.is`.

`loading()` means no data is available yet; `refreshing()` means a request is running while
last-good data remains renderable. `invalidate(meta)` marks the query stale and returns a
Promise that resolves only after a covering snapshot commits. Covered invalidations reject
when their load fails, the source changes, or the owner is disposed.

`refresh()` and `loadMore()` resolve when their attempt settles; load errors are exposed
through `error()`. Only `invalidate()` rejects because its Promise represents successful
coverage for cursor acknowledgement or similar adapter bookkeeping.

Errors thrown by computations that read the query's signals are not stored in `error()`;
they reach the nearest Solid error boundary or surface as unhandled errors. A committed
snapshot stays committed, so `invalidate()` still resolves.

An optional `subscribe` callback is set up once for the owner and may call `invalidate`.
Transport setup, message parsing, authorization, cursor interpretation, and retry policy stay
in the adapter. The returned cleanup runs exactly once on owner disposal.

### Infinite queries

```tsx
const conversations = query.createInfinite({
  source: () => ({ mailboxId: props.mailboxId, folderId: folderId() }),
  initial: {
    source: props.initialSource,
    pages: [props.initialPage],
  },
  loadPage: (source, { cursor, abortSignal }) =>
    api.loadConversations({ ...source, cursor, signal: abortSignal }),
  getNextCursor: (page) => page.nextCursor,
  isSameSource: (left, right) =>
    left.mailboxId === right.mailboxId && left.folderId === right.folderId,
});

const items = () => conversations.pages().flatMap((page) => page.items);
```

`loadMore()` coalesces parallel calls and appends one page. Canonical refreshes and
invalidations rebuild the currently loaded page count from page one with newly returned
cursors, then commit the complete chain atomically. stdlib does not flatten or deduplicate
page items and does not observe the DOM for infinite scroll. A source change loads only the
first page of the new source while keeping the old chain renderable until that page commits.
Pausing through `enabled` aborts an active `loadMore()` without changing the last-good pages.

## timed

Reactive debounce and interval with automatic cleanup on component unmount.

### Debounce

```tsx
import { timed } from "@k2b/stdlib/solid";

const { debouncedFn, trigger, cancel, isPending } = timed.debounce(
  (text: string) => saveSearch(text),
  500,
);

debouncedFn("hello");     // debounced
trigger("immediate");     // execute now
cancel();                 // cancel pending
isPending();              // boolean
```

### Interval

```tsx
const { start, stop, execute, isRunning } = timed.interval(
  () => fetchUpdates(),
  5000,
  { autoStart: true, executeImmediately: true },
);

stop();
start();
execute();    // run callback once without affecting interval
isRunning();  // boolean
```

## hotkeys

Global keyboard shortcut registry. The `mod` alias resolves to `Cmd` on Mac, `Ctrl` elsewhere.

```tsx
import { hotkeys } from "@k2b/stdlib/solid";

const { entries, dispose } = hotkeys.create({
  "mod+s": { label: "Save", run: () => save() },
  "mod+shift+z": { label: "Redo", run: () => redo() },
  "mod+k": { label: "Search", run: () => openSearch(), desc: "Open search" },
  "escape": { label: "Close", run: () => close(), inInput: true },
});

// entries() returns metadata for rendering a help overlay
// [{ keys: "mod+s", keysPretty: [{ key: "Cmd", ariaLabel: "Command" }, ...], label: "Save" }]
```

Hotkeys are registered on mount and unregistered on cleanup. Duplicate combos are ignored with a warning.

## dnd

Drag-and-drop with pointer and keyboard support. Uses SolidJS directives.

```tsx
import { dnd } from "@k2b/stdlib/solid";

const { draggable, droppable, isDragging, activeId, overId } = dnd.create({
  onDrop: ({ active, over, intent }) => {
    if (over) reorder(active.id, over.id);
  },
  onDragStart: ({ active }) => console.log("Dragging:", active.id),
  announcements: {
    dragStart: (active) => `Picked up ${active.id}`,
    drop: (active, over) => `Dropped ${active.id} on ${over?.id}`,
  },
});

// JSX
<div use:draggable={{ id: "item-1", meta: item1 }}>Drag me</div>
<div use:droppable={{ id: "zone-a", meta: zoneA }}>Drop here</div>
```

Supports activation distance, touch delay, custom collision detection, intent building, handle selectors, and ARIA live announcements.

Pointer drags clone the source (or its `[data-dnd-preview]` child) into a ghost appended to `document.body`.
Style its shadow and count badge with CSS custom properties; no `!important` is needed:

```css
:root {
  --stdlib-dnd-ghost-shadow: var(--app-shadow-float);
  --stdlib-dnd-badge-shadow: none;
  --stdlib-dnd-badge-bg: var(--app-accent);
}
```

The defaults remain `0 12px 28px rgba(0, 0, 0, 0.28)` for the ghost shadow,
`0 6px 16px rgba(37, 99, 235, 0.35)` for the badge shadow, and `rgb(59 130 246)`
for the badge background. Set properties on `:root`, `body`, or a selector matching the cloned preview.
Properties inherited only from a source ancestor are lost when the clone moves to `body`.

The controller and its directives clean themselves up with their Solid owner; `destroy()` is also safe to call manually and permanently disables the controller. Keyboard events from nested buttons, links, and form controls do not start a drag unless they match `handleSelector`.

Touch scrolling is preserved by default. For unrestricted touch dragging, apply `touch-action: none` to a dedicated handle; use the draggable's `touchAction: "none"` option only when disabling pan/zoom for the whole element is intentional. The touch delay continues asynchronously after movement, so a moved pointer can activate when the delay elapses without requiring another `pointermove`.

## detailPanel

Hybrid SSR + client-side detail panel pattern. Updates URL params without page reloads and supports browser back/forward.

```tsx
import { detailPanel } from "@k2b/stdlib/solid";

// In the detail panel component
const { item, itemKey } = detailPanel.createPanel({
  paramName: "user",
  eventName: "user-detail-select",
  initialItem: props.initialUser,
  initialKey: props.initialUserId,
  items: props.users,
  getItemKey: (user) => user.id,
});

// In the list component
const { selectedKey, select, deselect } = detailPanel.createList({
  paramName: "user",
  eventName: "user-detail-select",
  initialKey: props.selectedUserId,
});

<div onClick={() => select(user, user.id)}>
  {user.name}
</div>
```

## localStore

Reactive SolidJS store with automatic localStorage persistence and cross-tab sync via BroadcastChannel.
For simple non-reactive cookie storage, see `cookies` from `@k2b/stdlib/browser`.

```tsx
import { localStore } from "@k2b/stdlib/solid";

// Single record
const [user, setUser] = localStore.create("user", { name: "", email: "" });
setUser("name", "John");  // persisted + synced across tabs

// Query multiple keys
const [pads, reload] = localStore.query((key) => key.startsWith("pad:"));

// Direct operations
localStore.modify("user", (prev) => ({ ...prev, name: "Jane" }));
localStore.remove("user");
localStore.exists("user");  // boolean
localStore.read("user");    // T | null
```

## clipboard

Reactive clipboard helpers with auto-resetting copy-feedback state.

```tsx
import { clipboard } from "@k2b/stdlib/solid";

const { copy, wasCopied } = clipboard.create(2000);

<button onClick={() => copy("Hello!")}>
  {wasCopied() ? "Copied!" : "Copy"}
</button>
```

`wasCopied()` resets to `false` after the timeout (default 2000ms).
`clipboard.create(timeout?)` keeps the existing text-only API and catches Clipboard API errors.

Use `clipboard.createWriter()` when the consumer needs to write another value shape or
specialized clipboard content:

```tsx
const resourceCopy = clipboard.createWriter({
  write: writeCustomClipboardContent,
  copiedFor: 1800,
});

const success = await resourceCopy.copy(value);
resourceCopy.wasCopied(); // true only after the latest successful write
resourceCopy.error();     // Error from the latest write, or null
```

`copy()` returns `true` on success and `false` on failure. A new attempt clears old
feedback and errors immediately. Only the latest concurrent attempt may update reactive
state, and the Solid owner clears pending reset timers on disposal.

For both helpers, an error thrown by a computation that reads `wasCopied()` never counts as a
failed write; it reaches the nearest Solid error boundary or, without one, rejects `copy()`.

## clickOutside

Click-outside detection using a ref callback. Uses `mousedown` to detect before the element's own click handlers fire.

```tsx
import { clickOutside } from "@k2b/stdlib/solid";

const ref = clickOutside.create(() => setOpen(false));

<div ref={ref}>
  Dropdown content
</div>
```

## dropzone

Headless file drop zone with MIME type validation and nested-element-safe drag tracking.

```tsx
import { dropzone } from "@k2b/stdlib/solid";

const { isDragging, invalidDrag, handlers } = dropzone.create({
  onDrop: (files) => uploadFiles(files),
  accept: "image/*",
});

<div
  {...handlers}
  classList={{
    "border-blue-500": isDragging(),
    "border-red-500": invalidDrag(),
  }}
>
  Drop images here
</div>
```

## a11y

Accessible event handler spreads for non-button interactive elements.

```tsx
import { a11y } from "@k2b/stdlib/solid";

<div role="button" tabindex="0" {...a11y.clickOrEnter(handleAction)}>
  Click or press Enter
</div>
```

Returns `{ onClick, onKeyDown }` handlers that fire on click, Enter, and Space.
