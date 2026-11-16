---
title: Browser clients and mutations
navTitle: Clients and mutations
section: Frontend
order: 850
description: Call typed application APIs and handle user-initiated writes consistently.
tags: [browser, api, mutations]
updated: 2026-11-16
---

# Browser clients and mutations

Call application JSON APIs through a typed Hono client.

Wrap user-initiated async work in `mutation.create()` so loading, errors,
aborts, retries, and stale results follow one contract.

## Create a typed client

Export the Hono route type from the application server:

```ts
export type InventoryApi = typeof inventoryRoutes;
```

Create the browser client in a browser-safe module:

```ts
import { api } from "@k2b/cloud/browser";
import type { InventoryApi } from "../api";

export const inventoryApi = api.create<InventoryApi>({
  baseUrl: "/api/inventory",
});
```

The client infers route parameters and request payloads. Check `response.ok`
before reading success data.

On a page of the [Cloud app](/en/docs/frontend/mobile-app-pages), the client
also keeps the app session alive. When a request answers `401`, the client
renews the app session through Core and, once the phone has a valid session,
sends the request once more. A `401` means that the server did not apply the
request: the authentication middleware answers it before any route handler
runs, and a route that answers `401` itself must do so before it changes
anything, as described in
[Return expected failures](/en/docs/server/services-and-results#return-expected-failures).
The repeat therefore applies a change at most once. When the phone is no
longer paired, the app opens its pairing view instead. On the web, a `401` is
returned as it is.

On Cloud app pages, pending writes also hold automatic version-update reloads,
including a session renewal and retry. GET reads do not. See
[Pick up updates](/en/docs/frontend/mobile-app-pages#pick-up-updates).

Do not use raw `fetch()` for an application JSON API when its typed route is
available.

## Maintenance and app restarts

Every page built with the Cloud `Layout` watches its same-origin requests for
the gateway's `503` with code `maintenance` or `app_unavailable`. This covers
the typed client and raw `fetch()` alike; there is nothing to opt into. While
the Cloud is in maintenance or the app restarts:

- `GET` and `HEAD` requests stay pending and are sent again once it is over,
  so queries show their loading state, not an error. Requests with the same
  method and address wait as one: a polling query sends nothing more while it
  waits, and every caller gets its own copy of the one answer. At most 64
  addresses wait per page; a further read gets the `503` an action gets. Pass
  an `AbortSignal` as usual; aborting ends the wait with the signal's reason.
- Every other request is an action. It is sent once and never repeated. It
  answers `503` with the gateway's problem fields and a `message` in the
  person's language that names the reason. Show it as for any failed action,
  such as `prompts.error(error.message)` from your mutation's `onError`. Keep
  the person's input; they press again later.
- A persistent notice on the page says why, and says when it is over. The
  page does not reload.

Code that reads its own `503` answers sees `code` in the body, and in the
`X-Cloud-Unavailable` header also without a body. Branch on it, never on
`title` or `message`. See
[Open pages](/en/docs/operations/maintenance-mode#open-pages) for what people
see.

## Run a mutation

```tsx
import { mutation } from "@k2b/stdlib/solid";
import { toast } from "@k2b/ui";

const archive = mutation.create<void, { itemId: string }>({
  mutation: async ({ itemId }, { abortSignal }) => {
    const response = await inventoryApi.items[":id"].$delete(
      { param: { id: itemId } },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error("Item could not be archived.");
  },
  onSuccess: () => toast.success("Item archived"),
  onError: (error) => toast.error(error.message),
});
```

`mutate(vars)` starts the operation. `loading()`, `error()`, and `data()` are
reactive accessors. `status()` says where the mutation stands: `idle`,
`pending` while `onBefore` runs, `loading` while the mutation function runs,
then `success`, `error`, or `aborted` for the last call. `settledAt()` is the
time of the last end and changes on every end, also for two equal errors in a
row. Every place that reads one mutation shows the same state, no matter which
button, menu item, hotkey, or code started the call.

`abort()` cancels the active operation. An aborted fetch calls `onAbort`, not
`onError`. Both pending and running calls end `aborted` at once, with synchronous
status, `settledAt()`, `onAbort`, and `onFinally`. Late results are discarded, and
the mutation accepts a new call right after `abort()`. In `onBefore`, check the
second argument's `signal.aborted` after every `await` before optimistic changes.

`retry()` repeats the previous variables and context. It does not run
`onBefore` again. If the last accepted call never reached the mutation function,
`retry()` resolves `"dropped"` instead of repeating an older call. `onError`
receives the failed call as its third argument;
`run.retry()` repeats exactly that call, also after other calls ran, which
suits a "Try again" action in a toast.

A second call while one is `pending` or `loading` is dropped: it runs nothing,
changes no state, runs no hook (also not `onFinally`), and its Promise resolves
`"dropped"`. This guards double clicks, the Enter key in a form, and hotkeys
without a local `loading()` check. When the
newest call must win, as in search as you type, reads that follow a changing
selection or filter, or reloads after a change, create the mutation with
`concurrency: "replace"`. A newer call then starts anyway and a late result
from the older one is ignored. One mutation for many rows drops a click on a
second row while the first one runs; give each row its own mutation, or use
`concurrency: "replace"` when the rows' work is independent, such as
downloads.

`mutate()`, `retry()`, and `run.retry()` resolve with the outcome of this
call: `"success"`, `"error"`, `"aborted"`, `"dropped"`, or `"superseded"`.
`"superseded"` means the function ran, but a newer call replaced it and its result
was discarded; its server work may still have happened, and `onFinally` runs.
After `await`, read the outcome, not `error()` or `data()`, which may describe
another call:

```ts
if ((await update.mutate(values)) === "success") close();
```

Release a local busy flag set before `mutate()` in `finally` after awaiting the
call, because a dropped call runs no hook. Errors thrown by abort hooks reject
the call's Promise; `abort()` itself returns synchronously without throwing them.

To ask before the work starts, call `cancel()` from the second argument of
`onBefore`. The call ends as `aborted` without `onError` or `onAbort`, and
`retry()` does not repeat it. Ask first, then make optimistic changes, so a
cancel has nothing to undo.

Capture the complete retryable intent before the request starts. Mutation
variables or one-time context must include selected resources, destinations,
the request payload, idempotency keys, and correlation IDs. A retry must not
read a new choice from mutable UI state or reuse an idempotency key with a
different payload.

`onSuccess`, `onError`, `onAbort`, and `onFinally` are synchronous hooks. Their
return values are not awaited. Put work that defines the command outcome in the
mutation function. Track post-write reconciliation separately.

`error()` and `onError` report a failed mutation function or `onBefore` hook. `onSuccess`
runs after `data()` and `loading()` are updated; an error thrown there, or by a
component that renders the result, does not count as a failed write. A render
error reaches the island's boundary
([When an island fails](/en/docs/frontend/islands-and-hydration#when-an-island-fails)),
and `mutate()` and `retry()` reject with the remaining ones. Await `mutate()`
in `try`/`catch` only when the caller must react to such an error.

## Add optimistic state carefully

Every action answers at once, with an optimistic update or a pending state on
the acted element. [Show mutation state](/en/docs/frontend/forms-prompts-and-feedback#show-mutation-state)
decides which one an action gets and when it offers Undo. This section covers
the mechanics.

`onBefore` may return context used by success, error, abort, and finally hooks.
Use it to capture the previous UI state, such as a removed row and its
position, before the optimistic change.

Restore that state on error and abort, in the same place, so the item returns
where the person left it. Restore it only if no later action on the same item
has taken over that state, so an earlier failure never rolls back a newer
choice; then reconcile with the server. Do not optimistically grant
permission, expose new data, or pretend an irreversible action completed.

For an action that offers Undo, Undo either cancels a request that has not
been sent yet or sends a request that reverses the change on the server.
Cancelling an unsent request never makes a hard delete eligible for Undo. Undo
restores the captured state at once, so keep that context until the Undo
notice closes. Treat Undo as its own mutation: reconcile with the server after
it, and if the reversal is refused or fails, show the state the server kept
and an error with the reason.

The server remains authoritative. Reconcile the returned resource or reload
the affected server-backed view after success. If that refresh fails, keep
the optimistic result; the write already succeeded.

## Separate query and mutation state

Use a mutation for a user-initiated write or command. Do not use a mutation to
load a server-backed result set.

Start result sets with URL-addressed SSR data and keep them current with an
owner-local query. See
[Server-backed state](/en/docs/frontend/server-backed-island-state).

Do not turn the mutation result into a client-side cache of the application's
domain model.

See [Forms, prompts, and feedback](/en/docs/frontend/forms-prompts-and-feedback)
for presenting the operation.
