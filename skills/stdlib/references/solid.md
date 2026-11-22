# @k2b/stdlib/solid -- SolidJS Reactive Primitives

All primitives are imported from a single entry point:

```ts
import { mutation, query, timed, hotkeys, dnd, detailPanel, localStore, clipboard, clickOutside, dropzone, a11y } from "@k2b/stdlib/solid";
```

## Key Patterns

- All primitives that register listeners or timers auto-cleanup via SolidJS `onCleanup`.
- Most `create` functions must be called inside a SolidJS component or reactive owner (`createRoot`).
- Each module is exported as a namespace object with static methods (e.g. `mutation.create(...)`, `query.create(...)`, `timed.debounce(...)`).

---

## mutation

Async mutation controller with reactive loading/error/data signals, abort, and retry. Follows a pattern similar to React Query's `useMutation`.
Unlike lifecycle-bound Solid primitives, `mutation.create()` does not require a reactive owner.

### API

```ts
mutation.create<T, V, C = unknown>(options: MutationOptions<T, V, C>): MutationResult<T, V, C>
```

**MutationOptions<T, V, C>:**

| Field | Type | Description |
|---|---|---|
| `mutation` | `(vars: V, ctx: C & { abortSignal: AbortSignal }) => Promise<T>` | The async mutation function. Always receives an `abortSignal` in the context. |
| `initialData?` | `T` | Initial value for the data signal. |
| `concurrency?` | `"drop" \| "replace"` | Default `"drop"`: a call while another is pending or loading is ignored. `"replace"`: the newest call wins (autosave, search as you type). |
| `now?` | `() => number` | Clock for `settledAt` in ms. Default `Date.now`. |
| `onBefore?` | `(vars: V, control: { cancel: () => never; signal: AbortSignal }) => C \| Promise<C>` | Hook before mutation starts. Returns base context. NOT re-executed on `retry()`. `cancel()` calls the mutation off (ends `aborted`). `signal` fires when `abort()` ends the call; check it after every `await`. |
| `onSuccess?` | `(data: T, ctx?) => void` | Called on successful completion. |
| `onError?` | `(error: Error, ctx: C & { abortSignal } \| undefined, run: MutationRun) => void` | Called on error. `run.retry()` repeats exactly this call. `ctx` is `undefined` when `onBefore` failed. |
| `onAbort?` | `(ctx?) => void` | Called at once when `abort()` is called, or on an `AbortError`. `ctx` is `undefined` when `abort()` came while `onBefore` was pending. |
| `onFinally?` | `(ctx?) => void` | Called after completion regardless of outcome, also for a superseded call. Not called for a dropped call. |

**MutationResult<T, V, C>:**

| Field | Type | Description |
|---|---|---|
| `data` | `Accessor<T \| null>` | Reactive signal with mutation result. |
| `error` | `Accessor<Error \| null>` | Reactive signal with error. Read `status()` first: after an abort or `cancel()` it may hold an earlier call's error. |
| `loading` | `Accessor<boolean>` | Reactive signal: the mutation function is running. |
| `status` | `Accessor<MutationStatus>` | `"idle" \| "pending" \| "loading" \| "success" \| "error" \| "aborted"`. `pending` while `onBefore` runs. |
| `settledAt` | `Accessor<number \| null>` | Time of the last end (success, error, abort); strictly increasing; `null` before the first end. Wall clock: cap hold times computed from it. |
| `mutate` | `(vars: V) => Promise<MutationOutcome>` | Triggers the mutation. Executes `onBefore`. Resolves with this call's outcome; `"dropped"` at once when dropped. |
| `abort` | `() => void` | Ends the call in flight at once: `status()` `aborted`, `onAbort`/`onFinally` run. A pending call's later `onBefore` result is ignored (its `signal` fires); a running call's `abortSignal` fires and its late result is discarded. A new call is accepted right after. |
| `retry` | `() => Promise<MutationOutcome>` | Retries the last started call with same vars/context. Skips `onBefore`. Follows `concurrency`. `"dropped"` when there is nothing to repeat. |

`MutationOutcome` is `"success" | "error" | "aborted" | "dropped" | "superseded"`. `run.retry()` in `onError` resolves with it too.

Exported types: `MutationResult`, `MutationOptions`, `MutationStatus`, `MutationConcurrency`, `MutationOutcome`, `MutationRun`.

### Example

```tsx
const { data, error, loading, mutate, abort, retry } = mutation.create({
  mutation: async (vars: { name: string }, { abortSignal }) => {
    const res = await fetch("/api/items", {
      signal: abortSignal,
      method: "POST",
      body: JSON.stringify(vars),
    });
    return res.json();
  },
  onBefore: (vars) => {
    console.log("Starting mutation for:", vars.name);
    return { timestamp: Date.now() };
  },
  onSuccess: (data) => console.log("Created:", data),
  onError: (err) => console.error("Failed:", err),
});

// Trigger
mutate({ name: "New Item" });

// Abort in-flight request
abort();

// Retry last mutation (skips onBefore)
retry();

// Reactive UI
return (
  <div>
    <Show when={loading()}>Saving...</Show>
    <Show when={error()}>{(e) => <p>Error: {e().message}</p>}</Show>
    <Show when={data()}>{(d) => <p>Result: {JSON.stringify(d())}</p>}</Show>
  </div>
);
```

**Gotchas:**
- **Reactive owner**: `mutation.create()` can be used outside a component or `createRoot`; it registers no owner-bound cleanup.
- **Concurrent calls (since 0.34.0)**: by default a `mutate()`, `retry()`, or `run.retry()` while another call is `pending` or `loading` is dropped: nothing runs, no state changes, the Promise resolves. Autosave, search as you type, and other "newest wins" flows need `concurrency: "replace"`, or their last call is lost. With `"replace"`, the older run resolves `"superseded"` when its work finishes after the newer call reached its mutation function; its result is discarded, its work keeps running, and its `onFinally` still runs.
- **Status and hooks**: `status()`, `loading()`, `error()`, `data()`, and `settledAt()` are updated before `onSuccess`, `onError`, `onAbort`, and `onFinally` run, so a hook may start the next call. A throw in `onSuccess` keeps `status()` at `success`.
- **Read the outcome, not the signals**: after `await m.mutate(x)`, check the resolved outcome (`=== "success"`), not `m.error()` or `m.data()`. A dropped call leaves both untouched, so `if (!m.error()) close()` would close while another call still runs.
- **Local busy flags**: `onFinally` does not run for a dropped call. Release a flag set before `mutate()` after the `await` (or in a `finally`), not only in `onFinally`.
- **Many rows, one mutation**: under `drop`, a click on row B while row A saves is lost. Give each row its own mutation or use `concurrency: "replace"`.
- **abort() is a way out**: `abort(); mutate(next)` starts `next` at once, also under `drop` and also when the aborted function ignores its signal; the aborted run's late result never writes state. A pending `onBefore` ends `aborted` at once; its later result is ignored.
- **Cancel in onBefore**: `cancel()` ends the hook immediately and the call ends `aborted`, without `onError` or `onAbort`; `onFinally(undefined)` runs, `mutate()` resolves `"aborted"`, and `retry()` does not repeat the cancelled call. Write `return cancel()` so TypeScript narrows. Ask first, then change optimistically.
- **settledAt**: changes on every end, also for two equal errors in a row (strictly increasing, +1 ms if the clock did not move). Pass `now` to freeze time in tests.
- **Abort routing**: when the mutation function throws an `AbortError` (e.g. `fetch` aborted via the `abortSignal`), `onAbort` fires — not `onError`. Same when `abort()` is called explicitly. `onError` is reserved for genuine failures.
- **Consumer errors**: `onSuccess` runs after `data()` and `loading()` are updated. Errors thrown by `onSuccess` are not stored in `error()` or passed to `onError`; `mutate()` and `retry()` reject with them. Errors from computations that read the mutation's signals reach the nearest Solid error boundary or, without one, reject `mutate()`.

---

## query

Owner-local canonical reads with source changes, optional initial snapshots, last-good data,
refresh, invalidation, pause, subscription cleanup, and infinite pagination. There is no global
query client, shared cache, cache key registry, persistence, or cross-owner request deduplication.

Both query variants require a SolidJS reactive owner. Loads and subscriptions start after the
owner mounts on the client, never during server rendering. SSR data is optional and can be
provided through `initial`.

### query.create

```ts
query.create<TSource, TData, TInvalidation = void>(
  options: QueryOptions<TSource, TData, TInvalidation>
): QueryResult<TData, TInvalidation>
```

Important options:

| Field | Description |
|---|---|
| `source` | Reactive accessor for the current canonical source. |
| `load` | Transport-neutral async loader receiving the source, `abortSignal`, and cause. |
| `initial?` | Optional `{ source, data }` snapshot. Matching data suppresses the first request. |
| `enabled?` | Reactive pause accessor. Pending invalidations wait while false. |
| `isSameSource?` | Source comparator; defaults to `Object.is`. |
| `subscribe?` | Stable owner-scoped setup called once with `invalidate`; may return cleanup. |

The result exposes `data`, `error`, `loading`, `refreshing`, `stale`, `refresh`, `invalidate`,
and `abort`.

```tsx
const workspace = query.create({
  source: () => requestUrl(),
  initial: { source: props.requestUrl, data: props.data },
  enabled: () => !dialogOpen(),
  load: async (url, { abortSignal }) => {
    const response = await fetch(url, { signal: abortSignal });
    if (!response.ok) throw new Error("Could not load workspace");
    return response.json();
  },
});
```

Without matching initial data, the query loads automatically after client mount. A source change
aborts the old request and loads the new source while preserving last-good data. `loading()` is
reserved for a request without data; `refreshing()` means last-good data remains renderable.

`invalidate(meta)` is microtask-coalesced and returns one Promise per call. Each Promise resolves
only after a successful request that started after that invalidation. Invalidations received
during request A require one coalesced follow-up request B. Covered invalidations reject if their
load fails, the source changes, the query is aborted, or the owner is disposed.

`refresh()` and Infinite `loadMore()` resolve when their attempt settles and report load failures
through `error()`. Only `invalidate()` rejects because it represents successful snapshot coverage
for adapter acknowledgement.

Errors thrown by computations that read the query's signals are not stored in `error()`;
they reach the nearest Solid error boundary or surface as unhandled errors. A committed
snapshot stays committed, so `invalidate()` still resolves.

### query.createInfinite

```ts
query.createInfinite<TSource, TPage, TCursor, TInvalidation = void>({
  source,
  initial: { source: initialSource, pages: initialPages },
  loadPage: (source, { cursor, abortSignal, cause }) => loadPage(source, cursor, abortSignal),
  getNextCursor: (page) => page.nextCursor,
});
```

The result replaces `data` with `pages` and additionally exposes `loadingMore`, `hasMore`, and
`loadMore`. First-page loads use `cursor: undefined`. Parallel `loadMore()` calls share one
request. Canonical refreshes and invalidations supersede load-more and rebuild the currently
loaded page count from page one, following newly returned cursors. The complete new page chain is
committed atomically; an early terminal cursor may produce fewer pages. A source change loads only
the new first page and keeps the old page chain renderable until that page commits. Setting
`enabled` to false aborts an active load-more and preserves the last-good page chain.

stdlib never flattens or deduplicates page items. Pagination cursors remain separate from opaque
invalidation metadata such as event cursors. Viewport observation, transport lifecycle,
authorization, reconnect, retry/backoff, and cursor acknowledgement remain consumer-owned.

---

## timed

Debounce and interval utilities with automatic cleanup via `onCleanup`.

### timed.debounce

```ts
timed.debounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): {
  debouncedFn: (...args: Parameters<T>) => void;
  trigger: (...args: Parameters<T>) => void;  // immediate execution
  cancel: () => void;
  isPending: () => boolean;
}
```

Must be called inside a SolidJS reactive owner. Registers `onCleanup` to cancel pending timers.

#### Example

```tsx
const { debouncedFn, trigger, cancel, isPending } = timed.debounce(
  (text: string) => saveToServer(text),
  500
);

// Debounced call
debouncedFn("hello");

// Force immediate execution
trigger("save now");

// Cancel pending execution
cancel();

// Check status
if (isPending()) console.log("Save pending...");
```

### timed.interval

```ts
timed.interval(
  callback: () => void,
  delay: number,
  options?: {
    autoStart?: boolean;          // default: true
    executeImmediately?: boolean; // default: true
  }
): {
  start: () => void;
  stop: () => void;
  execute: () => void;   // run callback once without affecting interval
  isRunning: () => boolean;
}
```

Must be called inside a SolidJS reactive owner. Registers `onCleanup` to stop the interval.

#### Example

```tsx
// Auto-starts and executes immediately by default
const { stop, isRunning } = timed.interval(
  () => fetchUpdates(),
  5000
);

// Manual control
const { start, stop, execute, isRunning } = timed.interval(
  () => pollServer(),
  2000,
  { autoStart: false, executeImmediately: false }
);

start();    // begin interval
execute();  // run once without affecting interval
stop();     // stop interval
```

---

## hotkeys

Global keyboard shortcut registry. Uses a module-level singleton -- all components share one registry. Mac-aware: renders modifier symbols and resolves `mod` to Command/Ctrl.

### API

```ts
hotkeys.create(
  config?: HotkeyMap | (() => HotkeyMap | Promise<HotkeyMap>)
): {
  entries: Accessor<RegisteredHotkeyMeta[]>;  // all registered hotkeys
  dispose: () => void;                        // unregister all from this call
}

hotkeys.entries: Accessor<RegisteredHotkeyMeta[]>  // global reactive signal of all registered hotkeys
```

**HotkeyMap:** `Record<string, HotkeyDefinition>`

**HotkeyDefinition:**

| Field | Type | Description |
|---|---|---|
| `label` | `string` | Display label for the hotkey. |
| `run` | `() => void \| Promise<void>` | Handler function. |
| `desc?` | `string` | Optional description. |
| `inInput?` | `true` | If set, hotkey fires even inside text inputs. |

**RegisteredHotkeyMeta:**

| Field | Type | Description |
|---|---|---|
| `keys` | `string` | Normalized key combo (e.g. `"mod+s"`). |
| `keysPretty` | `PrettyKeyPart[]` | Display-friendly parts with `key` and `ariaLabel`. |
| `label` | `string` | The label. |
| `desc?` | `string` | Optional description. |

**PrettyKeyPart:** `{ key: string; ariaLabel: string }`

Key combo format: modifiers joined with `+`. Use `mod` for platform-aware Command/Ctrl. Example combos: `"mod+s"`, `"mod+shift+z"`, `"alt+k"`, `"escape"`.

On Mac, `mod` renders as the Command symbol. Modifier display: Meta/Cmd, Alt/Option, Shift, Ctrl all get Mac symbols automatically.

### Example

```tsx
// Inside a component -- auto-cleanup on unmount
const { entries } = hotkeys.create({
  "mod+s": {
    label: "Save",
    desc: "Save the current document",
    run: () => save(),
  },
  "mod+shift+z": {
    label: "Redo",
    run: () => redo(),
  },
  "escape": {
    label: "Close",
    run: () => closePanel(),
  },
});

// Render a hotkey help overlay
return (
  <ul>
    <For each={hotkeys.entries()}>
      {(entry) => (
        <li>
          <For each={entry.keysPretty}>
            {(part) => <kbd aria-label={part.ariaLabel}>{part.key}</kbd>}
          </For>
          {" "}{entry.label}
        </li>
      )}
    </For>
  </ul>
);
```

---

## dnd

Drag-and-drop system with pointer and keyboard support, ghost element rendering, collision detection, and ARIA live region announcements.

### API

```ts
dnd.create<TDragMeta, TDropMeta, TIntent>(
  options?: DndCreateOptions<TDragMeta, TDropMeta, TIntent>
): DndController<TDragMeta, TDropMeta, TIntent>
```

**DndCreateOptions:**

| Field | Type | Description |
|---|---|---|
| `activationDistance?` | `number` | Pixels before drag activates (default: 6). |
| `touchActivationDelayMs?` | `number` | Delay for touch drag activation (default: 120). Continues after movement without requiring another event. |
| `collisionDetector?` | `(ctx: DndCollisionContext) => DndId \| null` | Custom collision detection over every enabled droppable. Default prefers pointer containment, then nearest center. |
| `buildIntent?` | `(ctx: DndBuildIntentContext) => TIntent \| null` | Build custom intent (e.g. "before"/"after" for reordering). |
| `isSameIntent?` | `(a, b) => boolean` | Custom intent comparator. Default uses `===`. |
| `onDragStart?` | `(ctx: DndEventContext) => void` | Fired when drag begins. |
| `onDragOver?` | `(ctx: DndEventContext) => void` | Fired on drag movement over droppables. |
| `onDrop?` | `(ctx: DndEventContext) => void` | Fired on drop. |
| `onCancel?` | `(ctx: DndEventContext) => void` | Fired on cancel (Escape key or programmatic). |
| `announcements?` | `{ dragStart?, dragOver?, drop?, cancel? }` | ARIA live region announcement factories. |

**DndController:**

| Field | Type | Description |
|---|---|---|
| `draggable` | `(el, accessor) => void` | SolidJS directive for draggable elements. |
| `droppable` | `(el, accessor) => void` | SolidJS directive for droppable elements. |
| `activeId` | `Accessor<DndId \| null>` | Currently dragged item ID. |
| `overId` | `Accessor<DndId \| null>` | Current drop target ID. |
| `intent` | `Accessor<TIntent \| null>` | Current drop intent. |
| `isDragging` | `Accessor<boolean>` | Whether a drag is active. |
| `cancel` | `() => void` | Programmatically cancel the drag. |
| `destroy` | `() => void` | Permanently tear down all listeners and state. Also runs automatically with the Solid owner. |

**DndDraggableConfig:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique draggable ID. |
| `meta` | `TDragMeta` | Arbitrary metadata. |
| `disabled?` | `boolean` | Disable dragging. |
| `focusable?` | `boolean` | Auto-add to tab order (default: true). Set false if wrapping interactive elements. |
| `keyboard?` | `boolean` | Enable keyboard drag (Space/Enter to start, Arrows to move, Escape to cancel). |
| `handleSelector?` | `string` | CSS selector restricting drag start to a handle element. |
| `touchAction?` | `string` | Optional inline `touch-action` while mounted. Omit to preserve native touch scrolling. |

**DndDroppableConfig:**

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique droppable ID. |
| `meta` | `TDropMeta` | Arbitrary metadata. |
| `disabled?` | `boolean` | Disable dropping. |

Data attributes set automatically: `data-dnd-draggable`, `data-dnd-droppable`, `data-dnd-over`, `data-dnd-active` (and `aria-grabbed`, see warning below).

> [!WARNING] **`aria-grabbed` is deprecated** (removed from ARIA 1.2). Screen
> readers (NVDA, JAWS, VoiceOver) ignore it. The library still emits it for
> backward compatibility, but **do not rely on it for accessibility or CSS
> styling**.
>
> **What to use instead:**
> - **For a11y:** The library already emits an off-screen ARIA live region
>   (`role="status"`, `aria-live="polite"`) wired up via the `announcements`
>   option below. Make sure to provide `dragStart` / `dragOver` / `drop` /
>   `cancel` strings — that's how screen readers learn about the drag state.
> - **For CSS hooks:** target the data attributes `[data-dnd-draggable]`,
>   `[data-dnd-droppable]`, `[data-dnd-over]`, or the boolean
>   `[data-dnd-active="true"]` on the source element instead of
>   `[aria-grabbed="true"]`. The data attributes are stable and not part of
>   any ARIA spec, so they won't be deprecated.
> - **If migrating existing styles:** replace `[aria-grabbed="true"]` →
>   `[data-dnd-active="true"]` and `[aria-grabbed="false"]` →
>   `[data-dnd-active="false"]` (or drop the `false` rule — it's the default).

Ghost element: clones the source element (or its `[data-dnd-preview]` child) as a fixed-position overlay. Supports `data-dnd-count` attribute for badge rendering.

Style the ghost with `--stdlib-dnd-ghost-shadow`, `--stdlib-dnd-badge-shadow`, and
`--stdlib-dnd-badge-bg` (available since 0.31.1). Their fallbacks preserve the original
shadows (`0 12px 28px rgba(0, 0, 0, 0.28)` and `0 6px 16px rgba(37, 99, 235, 0.35)`)
and badge background (`rgb(59 130 246)`). For example, set
`--stdlib-dnd-ghost-shadow: var(--app-shadow-float)` on `:root`, `body`, or a selector
matching the cloned preview. The ghost moves to `document.body`, so custom properties
inherited only from a source ancestor do not follow it. No `!important` is needed.

Nested interactive controls do not start keyboard drags unless they match `handleSelector`. For mobile lists, preserve scrolling on the item and apply `touch-action: none` only to a dedicated drag handle (or set `touchAction: "none"` when disabling native pan/zoom for the whole draggable is intentional).

### Example

```tsx
const { draggable, droppable, isDragging, activeId, overId } = dnd.create<
  { label: string },
  { accepts: string },
  "before" | "after"
>({
  onDrop: ({ active, over, intent }) => {
    if (over) reorder(active.id, over.id, intent);
  },
  buildIntent: ({ active, over, pointer }) => {
    if (!over) return null;
    return pointer.y < over.center.y ? "before" : "after";
  },
  announcements: {
    dragStart: (active) => `Picked up ${active.meta.label}`,
    drop: (active, over) => `Dropped ${active.meta.label} on ${over?.meta.accepts ?? "nothing"}`,
  },
});

// Use as SolidJS directives
<div use:draggable={{ id: "item-1", meta: { label: "Task 1" }, keyboard: true }}>
  Drag me
</div>
<div use:droppable={{ id: "zone-a", meta: { accepts: "tasks" } }}>
  Drop here
</div>

// Use with a drag handle
<div use:draggable={{ id: "item-2", meta: { label: "Task 2" }, handleSelector: "[data-drag-handle]" }}>
  <span data-drag-handle style={{ "touch-action": "none" }}>Grip</span>
  <span>Content</span>
</div>

// React to drag state
<div classList={{ "opacity-50": isDragging() && activeId() === "item-1" }}>
  ...
</div>
```

---

## detailPanel

URL-synced detail panel with browser history management. Designed for list/detail layouts where selecting an item opens a detail view without page reload.

### API

```ts
detailPanel.createPanel<T>(options: DetailPanelOptions<T>): DetailPanelController<T>
detailPanel.createList<T>(options: { paramName: string; eventName: string; initialKey: string | null }): {
  selectedKey: Accessor<string | null>;
  select: (item: T, key: string) => void;
  deselect: () => void;
}
detailPanel.select<T>(paramName: string, eventName: string, item: T | null, itemKey: string | null): void
detailPanel.dispatch<T>(eventName: string, item: T | null, itemKey: string | null): void
detailPanel.shouldHandleClick(event: MouseEvent, anchor?: HTMLAnchorElement | null): boolean
detailPanel.setUrlParam(paramName: string, value: string | null, mode?: "push" | "replace"): void
detailPanel.getUrlParam(paramName: string): string | null
```

**Note:** `setUrlParam` now defaults to `history.pushState` so Back/Forward navigation works between selections (the documented contract of the URL-synced panel). Pass `"replace"` for the initial URL sync where you don't want to add a history entry. Previously the function always used `replaceState`, breaking Back-button behavior.

**DetailPanelOptions<T>:**

| Field | Type | Description |
|---|---|---|
| `paramName` | `string` | URL search parameter name. |
| `eventName` | `string` | Custom event name for cross-component sync. |
| `initialItem` | `T \| null` | SSR-provided initial item. |
| `initialKey` | `string \| null` | SSR-provided initial key. |
| `items` | `T[]` | All items for popstate lookup. |
| `getItemKey` | `(item: T) => string` | Key extractor. |

**DetailPanelController<T>:** `{ item: Accessor<T | null>; itemKey: Accessor<string | null> }`

### Example

```tsx
// Detail panel component
const { item, itemKey } = detailPanel.createPanel({
  paramName: "user",
  eventName: "user-select",
  initialItem: props.initialUser,
  initialKey: props.initialUserId,
  items: props.users,
  getItemKey: (u) => u.id,
});

return (
  <Show when={item()} fallback={<p>Select a user</p>}>
    {(user) => <UserCard user={user()} />}
  </Show>
);

// List component
const { selectedKey, select, deselect } = detailPanel.createList<User>({
  paramName: "user",
  eventName: "user-select",
  initialKey: props.selectedUserId,
});

return (
  <For each={props.users}>
    {(user) => (
      <div
        classList={{ active: selectedKey() === user.id }}
        onClick={() => select(user, user.id)}
      >
        {user.name}
      </div>
    )}
  </For>
);
```

---

## localStore

Reactive localStorage with SolidJS stores and cross-tab synchronization via BroadcastChannel.
For simple non-reactive cookie storage, see `cookies` from `@k2b/stdlib/browser`.

### API

```ts
localStore.create<T extends Record<string, any>>(
  key: string,
  defaultValue: T,
  options?: { storage?: Storage; serializer?: Serializer }
): [Store<StoreItem<T>>, SetStoreFunction<StoreItem<T>>]

localStore.query<T extends Record<string, any>>(
  keysFilter?: (key: string) => boolean,
  options?: { storage?: Storage; enhanceRecord?: (item: StoreItem<T>) => StoreItem<T>; serializer?: Serializer }
): [Store<StoreItem<T>[]>, () => void]  // [stores, reload]

localStore.remove(key: string, storage?: Storage): void
localStore.modify<T>(key: string, value: T | ((prev?: T) => T), options?: { storage?: Storage; serializer?: Serializer }): void
localStore.exists(key: string, storage?: Storage): boolean
localStore.read<T>(key: string, options?: { storage?: Storage; serializer?: Serializer }): T | null
```

`StoreItem<T>` is `T & { _key: string }` -- every store item includes the localStorage key as `_key`.

The `create` function must be called inside a SolidJS reactive owner (registers `onCleanup` for the sync subscription). The `query` function also registers `onCleanup`.

Changes made via `setStore` are automatically persisted to localStorage and broadcast to other tabs. Other tabs receive the update and reactively update their stores.

The shared channel is created lazily on the first synchronization-capable
`localStore` call and only when `window.BroadcastChannel` exists. Importing
`@k2b/stdlib/solid` does not create a channel or retain a Bun process handle.

### Example

```tsx
// Single record store
const [settings, setSettings] = localStore.create("app-settings", {
  theme: "light",
  fontSize: 14,
});

setSettings("theme", "dark");       // auto-persists, syncs across tabs
console.log(settings.theme);        // "dark"
console.log(settings._key);         // "app-settings"

// Query multiple keys
const [pads, reload] = localStore.query<PadData>(
  (key) => key.startsWith("pad:")
);

// Direct operations (no reactive owner needed)
localStore.modify("pad:abc", { title: "Updated" });
localStore.modify("counter", (prev) => ({ count: (prev?.count ?? 0) + 1 }));
localStore.remove("pad:abc");
const exists = localStore.exists("pad:abc");
const data = localStore.read<PadData>("pad:abc");
```

**Gotchas:**
- Stored JSON is validated on read: if the parsed value isn't a plain object whose `_key` matches the requested key (e.g. null, an array, a primitive, or a key from a different `localStore`), `create()` falls back to the default value instead of handing the caller a malformed reactive store.
- Cross-tab updates (`storage` event from another tab) use `reconcile()` for full replacement — deleted properties disappear, no stale fields leak through. Previously a partial `setStore(object)` merge could leave removed fields visible after a cross-tab remove.

---

## clipboard

Reactive copy feedback for text and consumer-provided asynchronous clipboard writers.

### API

```ts
clipboard.create(timeout?: number): {
  copy: (text: string) => Promise<void>;
  wasCopied: Accessor<boolean>;
}

clipboard.createWriter<T>({
  write: (value: T) => Promise<void>,
  copiedFor?: number,
}): {
  copy: (value: T) => Promise<boolean>;
  wasCopied: Accessor<boolean>;
  error: Accessor<Error | null>;
}
```

Both helpers default to 2000ms and must be called inside a SolidJS reactive owner.
`create()` keeps its text-only `Promise<void>` API and logs Clipboard API failures.
`createWriter()` returns whether the write succeeded, clears an earlier error when a new
attempt starts, and only lets the latest concurrent invocation update state. Its feedback
timer restarts after every latest successful write and is cleared with the owner.

For both helpers, an error thrown by a computation that reads `wasCopied()` never counts as a
failed write; it reaches the nearest Solid error boundary or, without one, rejects `copy()`.

### Example

```tsx
const { copy, wasCopied } = clipboard.create(3000);

return (
  <button onClick={() => copy("Hello, world!")}>
    {wasCopied() ? "Copied!" : "Copy"}
  </button>
);

const resourceCopy = clipboard.createWriter({
  write: writeCustomClipboardContent,
  copiedFor: 1800,
});

const success = await resourceCopy.copy(value);
resourceCopy.wasCopied();
resourceCopy.error();
```

---

## clickOutside

Click-outside detection. Returns a ref callback to attach to the tracked element.

### API

```ts
clickOutside.create(callback: () => void): (el: HTMLElement) => void
```

Must be called inside a SolidJS component. Listens on `mousedown` (not `click`) to detect outside interaction before the target's own click handlers fire. Auto-cleanup via `onCleanup`.

### Example

```tsx
const ref = clickOutside.create(() => setOpen(false));

return (
  <Show when={open()}>
    <div ref={ref} class="dropdown">
      Dropdown content
    </div>
  </Show>
);
```

---

## dropzone

Headless file drop zone with MIME type validation. Uses a drag counter pattern for correct nested-element handling.

### API

```ts
dropzone.create(options: DropzoneOptions): {
  isDragging: () => boolean;
  invalidDrag: Accessor<boolean>;
  handlers: DropzoneHandlers;
}
```

**DropzoneOptions:**

| Field | Type | Description |
|---|---|---|
| `onDrop?` | `(files: File[]) => void` | Called with validated files on drop. |
| `accept?` | `string` | MIME filter (e.g. `"image/*"`, `"image/jpeg,image/png"`). |

**DropzoneHandlers:** `{ onDragEnter, onDragLeave, onDragOver, onDrop }` -- spread on the drop target element.

`invalidDrag` is `true` when dragged files do not match the `accept` filter.

### Example

```tsx
const { isDragging, invalidDrag, handlers } = dropzone.create({
  onDrop: (files) => uploadFiles(files),
  accept: "image/*",
});

return (
  <div
    {...handlers}
    classList={{
      "border-blue-500": isDragging() && !invalidDrag(),
      "border-red-500": isDragging() && invalidDrag(),
      "border-gray-300": !isDragging(),
    }}
  >
    {isDragging() ? (invalidDrag() ? "Invalid file type" : "Drop here") : "Drag files here"}
  </div>
);
```

**Gotcha:** `isDragging()` only flips to `true` when the drag actually contains files (either via `dataTransfer.types.includes("Files")` or at least one `DataTransferItem` with `kind === "file"`). Plain text or link drags no longer trigger the file-drop UI.

---

## a11y

Accessibility utilities for non-button interactive elements.

### API

```ts
a11y.clickOrEnter(
  fn: (e: MouseEvent | KeyboardEvent) => void
): {
  onClick: JSX.EventHandler<HTMLElement, MouseEvent>;
  onKeyDown: JSX.EventHandler<HTMLElement, KeyboardEvent>;
}
```

Returns spreadable event handlers that fire `fn` on click, Enter, or Space. Both handlers call `stopPropagation`; the keyboard handler also calls `preventDefault`.

Does not require a reactive owner -- can be used anywhere.

### Example

```tsx
<div role="button" tabindex="0" {...a11y.clickOrEnter(() => doAction())}>
  Click or press Enter
</div>

// With dynamic handler
<For each={items}>
  {(item) => (
    <div role="button" tabindex="0" {...a11y.clickOrEnter(() => selectItem(item.id))}>
      {item.name}
    </div>
  )}
</For>
```
