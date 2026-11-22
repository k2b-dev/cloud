# SolidJS Patterns Guide

Comprehensive patterns for all solid modules in stdlib.

## 1. Reactive Lifecycle

Functions that register lifecycle cleanup must be called inside a reactive owner (component body
or `createRoot`). Signals themselves do not require an owner. Where cleanup is registered, it runs
automatically via `onCleanup`.

```tsx
import { createRoot } from "solid-js";
import { mutation, query, timed, clipboard } from "@k2b/stdlib/solid";

// Inside a component -- cleanup is automatic
function MyComponent() {
  const { copy, wasCopied } = clipboard.create();          // OK
  const { mutate } = mutation.create({ mutation: fetchData }); // OK
  const items = query.create({ source: () => "/items", load: fetchItems }); // OK
  const { debouncedFn } = timed.debounce(save, 500);       // OK
  return <div>...</div>;
}

// mutation.create registers no lifecycle cleanup and also works outside a component
const standaloneMutation = mutation.create({ mutation: fetchData });

// Lifecycle-bound primitives still need an owner
createRoot((dispose) => {
  const { debouncedFn } = timed.debounce(save, 500);
  dispose();
});
```

Gotcha: lifecycle-bound primitives such as `timed.debounce()` need an owner for `onCleanup`.
`mutation.create()` is owner-independent.

## 2. Mutation Pattern (React Query-like)

`mutation.create` wraps async operations with reactive `loading`/`error`/`data` signals.
Supports `onBefore` for optimistic updates, `retry()` to replay, and `abort()` to cancel.

`onSuccess` runs after `data()` and `loading()` are updated. Errors thrown by `onSuccess` are not
stored in `error()` or passed to `onError`; `mutate()` and `retry()` reject with them. The same
holds for computations that read the mutation's signals: their errors reach the nearest Solid
error boundary or, without one, reject `mutate()`.

```tsx
import { mutation } from "@k2b/stdlib/solid";

function TodoCreator() {
  const { data, error, loading, mutate, retry, abort } = mutation.create({
    mutation: async (vars: { title: string }, { abortSignal }) => {
      const res = await fetch("/api/todos", {
        method: "POST",
        body: JSON.stringify(vars),
        signal: abortSignal,
      });
      return res.json();
    },
    onBefore: async (vars, { cancel }) => {
      // Ask first, then change optimistically, so a cancel has nothing to undo.
      if (!(await confirmCreate(vars.title))) return cancel();
      const optimistic = { id: "temp", ...vars };
      addToList(optimistic);
      return { optimistic }; // returned as context for rollback
    },
    onSuccess: (todo) => replaceInList("temp", todo),
    onError: (_err, ctx) => {
      if (ctx) removeFromList(ctx.optimistic.id);
    },
    onAbort: (ctx) => removeFromList(ctx?.optimistic.id),
  });

  return (
    <div>
      <button onClick={() => mutate({ title: "New todo" })} disabled={loading()}>
        {loading() ? "Creating..." : "Create"}
      </button>
      <button onClick={abort}>Cancel</button>
      {error() && <button onClick={retry}>Retry</button>}
      {error() && <p>Error: {error()!.message}</p>}
    </div>
  );
}
```

Gotchas:
- `retry()` does NOT re-run `onBefore` -- it reuses the previous context. One-time side
  effects in `onBefore` will not repeat.
- Non-Error throws are normalized: `throw "oops"` becomes `new Error("oops")`.
- `mutate()` while a call is `pending` or `loading` is dropped by default. Use
  `concurrency: "replace"` when the newest call must win; it does not abort the older call.
- `status()` and `settledAt()` let several buttons, menu items, or hotkeys show the same
  state of one mutation, no matter which of them started it.
- `onError` gets `run` as its third argument; `run.retry()` repeats exactly that call.
- `mutate()` resolves `"success" | "error" | "aborted" | "dropped" | "superseded"`. Read that after `await`,
  not `error()` or `data()`, which may describe another call.
- `abort(); mutate(next)` starts `next` at once, also under the default `drop`.

## 3. Timing Patterns

`timed.debounce` delays execution until input settles. `timed.interval` runs a callback
repeatedly. Both auto-cleanup on component unmount.

```tsx
import { createSignal } from "solid-js";
import { timed } from "@k2b/stdlib/solid";

function SearchInput() {
  const [query, setQuery] = createSignal("");
  const [results, setResults] = createSignal([]);

  const { debouncedFn: search, trigger, cancel, isPending } = timed.debounce(
    async (text: string) => {
      const res = await fetch(`/api/search?q=${text}`);
      setResults(await res.json());
    },
    300,
  );

  return (
    <div>
      <input
        value={query()}
        onInput={(e) => {
          setQuery(e.target.value);
          search(e.target.value);       // fires after 300ms of no typing
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") trigger(query()); // immediate on Enter
        }}
      />
      {isPending() && <span>Searching...</span>}
    </div>
  );
}

// Polling with interval
function StatusPoller() {
  const { stop, isRunning } = timed.interval(
    () => fetch("/api/status").then(updateStatus),
    5000,
    { autoStart: true, executeImmediately: true },
  );

  return <button onClick={stop}>{isRunning() ? "Stop" : "Stopped"}</button>;
}
```

Gotcha: `timed.interval` defaults to `autoStart: true` and `executeImmediately: true`, so
the callback runs once right away and then every `delay` ms.

## 4. Hotkey System

Global singleton registry -- one system per app. Mac-aware display (shows symbols on Mac,
text on other platforms). Use `mod+k` for platform-adaptive shortcuts.

```tsx
import { hotkeys } from "@k2b/stdlib/solid";
import { For } from "solid-js";

function App() {
  const { entries } = hotkeys.create({
    "mod+s": {
      label: "Save",
      desc: "Save current document",
      run: () => saveDocument(),
    },
    "mod+k": {
      label: "Search",
      run: () => openSearchDialog(),
    },
    "mod+/": {
      label: "Help",
      run: () => toggleHelp(),
      inInput: true, // also fires when focused in text fields
    },
  });

  // Render a keyboard shortcut cheat sheet
  return (
    <ul>
      <For each={entries()}>
        {(hk) => (
          <li>
            <kbd>
              {hk.keysPretty.map((p) => p.key).join("+")}
            </kbd>
            {" "}{hk.label}
          </li>
        )}
      </For>
    </ul>
  );
}
```

Gotchas:
- Duplicate combos are silently ignored with a console warning.
- Config can be a static object or an `async () => HotkeyMap` factory for lazy loading.
- Hotkeys registered inside a component auto-unregister on unmount.
- `mod` resolves to `meta` (Cmd) on Mac and `ctrl` on other platforms.

## 5. Drag & Drop Architecture

`dnd.create` returns `draggable`/`droppable` SolidJS directives. Supports pointer
(mouse/touch) and keyboard (Space to grab, arrows to move, Enter to drop, Escape to cancel).

```tsx
import { createSignal, For } from "solid-js";
import { dnd } from "@k2b/stdlib/solid";

type Item = { id: string; label: string };

function SortableList() {
  const [items, setItems] = createSignal<Item[]>([
    { id: "1", label: "First" },
    { id: "2", label: "Second" },
    { id: "3", label: "Third" },
  ]);

  const { draggable, droppable, isDragging, activeId } = dnd.create<Item, Item, null>({
    onDrop: ({ active, over }) => {
      if (!over) return;
      setItems((prev) => {
        const fromIdx = prev.findIndex((i) => i.id === active.id);
        const toIdx = prev.findIndex((i) => i.id === over.id);
        const next = [...prev];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        return next;
      });
    },
  });

  return (
    <ul classList={{ "opacity-75": isDragging() }}>
      <For each={items()}>
        {(item) => (
          <li
            use:draggable={{ id: item.id, meta: item }}
            use:droppable={{ id: item.id, meta: item }}
            classList={{ "ring-2": activeId() === item.id }}
          >
            {item.label}
          </li>
        )}
      </For>
    </ul>
  );
}
```

Gotchas:
- `draggable` auto-sets `tabindex="0"` unless `focusable: false`.
- Use `handleSelector` to restrict drag initiation to a grip icon.
- Native touch scrolling is preserved by default. Apply `touch-action: none` to a dedicated handle (or use `touchAction: "none"` deliberately) for unrestricted touch dragging.
- Nested buttons, links, and form controls do not start keyboard drags unless they match `handleSelector`.
- Ghost element is auto-cloned from the dragged element (or its `[data-dnd-preview]` child).
- Default collision detection prefers pointer containment, then the nearest center; custom detectors receive every enabled droppable.

## 6. Cross-Tab Sync

`localStore.create` persists to `localStorage` and syncs across tabs via `BroadcastChannel`.
`localStore.query` watches multiple keys with a filter function.

```tsx
import { localStore } from "@k2b/stdlib/solid";

function Settings() {
  const [settings, setSettings] = localStore.create("app:settings", {
    theme: "light",
    fontSize: 14,
  });

  return (
    <div>
      <p>Current theme: {settings.theme}</p>
      <button onClick={() => setSettings("theme", "dark")}>Dark mode</button>
      <button onClick={() => setSettings("fontSize", (prev) => prev + 1)}>
        Bigger text ({settings.fontSize}px)
      </button>
    </div>
  );
}

// Query multiple stores
function AllNotes() {
  const [notes, reload] = localStore.query<{ title: string; body: string }>(
    (key) => key.startsWith("note:"),
  );

  return (
    <div>
      <For each={notes}>{(note) => <p>{note.title}</p>}</For>
      <button onClick={reload}>Refresh</button>
    </div>
  );
}

// Imperative helpers (no reactive owner needed)
localStore.modify("app:settings", (prev) => ({ ...prev, theme: "dark" }));
localStore.remove("note:old");
const exists = localStore.exists("app:settings");
const data = localStore.read<{ theme: string }>("app:settings");
```

Gotcha: every store item has an internal `_key` field set automatically -- do not overwrite it.

## 7. Detail Panel + URL Sync

`detailPanel.createPanel` syncs selected item to URL query params using
`history.replaceState` (no extra back-button entries). Handles browser back/forward.

```tsx
import { Show, For } from "solid-js";
import { detailPanel } from "@k2b/stdlib/solid";

type User = { id: string; name: string; email: string };

function UserPanel(props: { users: User[]; initialUser: User | null }) {
  const { item, itemKey } = detailPanel.createPanel({
    paramName: "user",
    eventName: "user-select",
    initialItem: props.initialUser,
    initialKey: props.initialUser?.id ?? null,
    items: props.users,
    getItemKey: (u) => u.id,
  });

  return (
    <Show when={item()} fallback={<p>Select a user</p>}>
      {(user) => <div><h2>{user().name}</h2><p>{user().email}</p></div>}
    </Show>
  );
}

function UserList(props: { users: User[]; selectedId: string | null }) {
  const { selectedKey, select, deselect } = detailPanel.createList<User>({
    paramName: "user",
    eventName: "user-select",
    initialKey: props.selectedId,
  });

  return (
    <ul>
      <For each={props.users}>
        {(user) => (
          <li
            classList={{ "bg-blue-100": selectedKey() === user.id }}
            onClick={(e) => {
              if (!detailPanel.shouldHandleClick(e)) return;
              e.preventDefault();
              selectedKey() === user.id ? deselect() : select(user, user.id);
            }}
          >
            {user.name}
          </li>
        )}
      </For>
    </ul>
  );
}
```

Gotcha: `shouldHandleClick` returns false for middle-clicks and modifier-clicks so that
"open in new tab" still works.

## 8. Composition Patterns

### Auto-save with mutation + debounce

```tsx
function AutoSaveEditor() {
  const { mutate, loading } = mutation.create({
    // The newest text must win; the default "drop" would lose edits made while saving.
    concurrency: "replace",
    mutation: async (body: string, { abortSignal }) => {
      await fetch("/api/doc", { method: "PUT", body, signal: abortSignal });
    },
  });
  const { debouncedFn: save } = timed.debounce((text: string) => mutate(text), 1000);

  return <textarea onInput={(e) => save(e.target.value)} />;
}
```

### Dismissible panel with clickOutside + detailPanel

```tsx
function DismissibleDetail() {
  const { item } = detailPanel.createPanel({ /* ... */ });
  const ref = clickOutside.create(() => detailPanel.select("item", "item-select", null, null));

  return (
    <Show when={item()}>
      {(data) => <div ref={ref}>{data().name}</div>}
    </Show>
  );
}
```

### File upload with dropzone + mutation

```tsx
function FileUploader() {
  const { mutate, loading, error } = mutation.create({
    mutation: async (files: File[], { abortSignal }) => {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      await fetch("/api/upload", { method: "POST", body: form, signal: abortSignal });
    },
  });
  const { isDragging, handlers } = dropzone.create({
    onDrop: (files) => mutate(files),
    accept: "image/*",
  });

  return (
    <div {...handlers} classList={{ "border-blue-500": isDragging() }}>
      {loading() ? "Uploading..." : "Drop images here"}
      {error() && <p>{error()!.message}</p>}
    </div>
  );
}
```

### Offline-first with localStore + mutation

```tsx
function OfflineNote() {
  const [note, setNote] = localStore.create("draft:current", { text: "" });
  const { mutate, error } = mutation.create({
    mutation: async (text: string) => {
      await fetch("/api/notes", { method: "POST", body: text });
    },
    onSuccess: () => localStore.remove("draft:current"),
  });

  return (
    <div>
      <textarea value={note.text} onInput={(e) => setNote("text", e.target.value)} />
      <button onClick={() => mutate(note.text)}>Sync to server</button>
      {error() && <p>Saved locally, sync failed</p>}
    </div>
  );
}
```

## 9. Owner-local Query Reads

Use `query.create` for canonical reads and `mutation.create` for user-initiated writes. A query
belongs to the Solid owner that creates it; equal sources in different owners do not share data
or requests.

```tsx
const items = query.create({
  source: () => `/api/items?filter=${encodeURIComponent(filter())}`,
  initial: { source: props.requestUrl, data: props.items },
  load: async (url, { abortSignal }) => {
    const response = await fetch(url, { signal: abortSignal });
    if (!response.ok) throw new Error("Could not load items");
    return response.json();
  },
});
```

Matching initial data is treated as the current canonical snapshot and avoids a hydration
request. Without initial data, loading starts automatically after client mount. Server rendering
does not start loads or subscriptions. Call `refresh()` for an explicit reload and
`invalidate(meta)` when an external event makes the current snapshot stale.

Subscriptions stay transport-neutral:

```tsx
type Items = Awaited<ReturnType<typeof loadItems>>;
type LiveInvalidation = { cursor: string };

const items = query.create<string, Items, LiveInvalidation>({
  source: () => requestUrl(),
  load: loadItems,
  subscribe: ({ invalidate }) =>
    messages.subscribe((message) => {
      void invalidate({ cursor: message.cursor })
        .then(() => messages.markApplied(message.cursor))
        .catch(() => {
          // The adapter owns replay and retry policy.
        });
    }),
});
```

For pagination, `query.createInfinite` keeps Page objects intact. Render flattened items in the
consumer and trigger `loadMore()` from the UI; the query does not install an intersection
observer.

`refresh()` and `loadMore()` resolve after their attempt settles and expose failures through
`error()`. `invalidate()` is different: it rejects unless a covering snapshot commits, so an
adapter can acknowledge an event cursor only after successful coverage.

Errors thrown by computations that read the query's signals are not stored in `error()`;
they reach the nearest Solid error boundary or surface as unhandled errors. A committed
snapshot stays committed, so `invalidate()` still resolves.

## 10. Common Gotchas

A summary of the most frequent pitfalls across all modules.

```
mutation.retry()     Does NOT re-run onBefore. Uses previous context.
                     Use mutate(sameArgs) if you need onBefore again.

mutation.mutate()    Dropped while another call is pending or loading (default
                     concurrency "drop"); resolves "dropped" and runs no hook.
                     Autosave and search as you type need concurrency: "replace".
                     After await, branch on the outcome, not on error()/data().

query                Owner-local only; no global cache or cross-owner deduplication.
                     Matching initial data skips the first request.
                     Loads and subscriptions start after client mount.

hotkeys              Uses navigator.userAgentData (modern) with
                     navigator.userAgent fallback for Mac detection.

dnd.draggable        Needs tabindex="0" for keyboard support.
                     Set automatically unless focusable: false.

localStore           Items always have an internal _key field.
                     Do not use "_key" as your own field name.

clipboard.create     The timeout timer auto-cleans via onCleanup.
                     wasCopied() resets to false after timeout (default 2s).
                     Without an error boundary, a computation that throws
                     on wasCopied() rejects copy().

timed.debounce       trigger() fires immediately AND cancels any pending
                     debounced call. cancel() only cancels without firing.

timed.interval       Both autoStart and executeImmediately default to true.
                     Pass { autoStart: false } if you want manual start.

clickOutside         Uses mousedown, not click. This means the callback
                     fires before the target's own click handlers.

dropzone             Uses a drag counter internally. isDragging() stays true
                     even when the pointer moves between child elements.
```
