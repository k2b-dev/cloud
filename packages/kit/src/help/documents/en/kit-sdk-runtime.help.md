---
id: kit-sdk-runtime
title: Kit API — start here
icon: ti ti-code
description: Run a first script, choose a reference, and understand effects and limits.
order: 190
---

Build the interface in `run()`, then do work from callbacks. The user must click **Launch**; scripts do not start automatically. Editor previews use the draft. Restart a preview after changing JavaScript.

## First working script {icon="player-play"}

Create `main.script.js`, paste this code, save, and launch:

```js
export default kit.script({
  name: "Names",
  run() {
    const result = kit.ui.text("No name yet");
    kit.ui.button("Add name", async () => {
      const name = await kit.ui.modal.text({
        title: "Add name", label: "Name", required: true
      });
      if (name === null) return;
      result.set(name);
    });
  }
});
```

The button opens a dialog. Confirming changes the displayed text; cancelling changes nothing. This example stores no data.

## Find the contract {icon="search"}

| Task | Reference |
|---|---|
| Compose buttons, inputs and layouts | [UI](/app/kit/help/kit-sdk-ui), [option fields](/app/kit/help/kit-sdk-ui-types) |
| Update lists, tables and controls | [UI handles](/app/kit/help/kit-sdk-handles) |
| Ask for confirmation or form values | [Modals](/app/kit/help/kit-sdk-modals) |
| Show a chart | [Charts and every chart field](/app/kit/help/kit-sdk-charts) |
| Pick/download files and parse CSV | [Files](/app/kit/help/kit-sdk-file), [CSV](/app/kit/help/kit-sdk-sheet) |
| Read PDF text | [PDF](/app/kit/help/kit-sdk-pdf) |
| Calculate exact amounts | [Money](/app/kit/help/kit-sdk-money) |
| Save per-user local values/files | [KV](/app/kit/help/kit-sdk-store), [OPFS](/app/kit/help/kit-sdk-opfs) |
| Share records with other users | [Database](/app/kit/help/kit-sdk-db) |

`cld kit sdk` exposes the same reference data, including argument definitions and JSON schemas. Agents use `search_help` and `read_help` for these articles. There is no separate SDK capability.

## Values and errors {icon="info-circle"}

A field marked optional may be omitted or `undefined`. It does not accept `null` unless explicitly listed. `{}` means an options object with no overrides; `[]` means an empty collection. `JSON` means strings, finite numbers, booleans, null, arrays and objects containing only JSON values: no functions, handles, BigInt or cycles.

UI constructors and handle methods are synchronous. Host calls return Promises; `await` them inside `async run()` or an async callback. Return the Promise from a callback so Kit can track its lifetime. While a callback is pending, other callbacks are not executed. Input values may still change. Do not use a long async `onChange` as a work queue.

Catch errors when the user can recover. Otherwise, Kit shows the error in the console. `console.log`, `info`, `warn` and `error` are redirected; logs are diagnostic, not persistent records. Callbacks and `run()` receive no hidden arguments or Cloud credentials. Programmatic `set()` does not invoke `onChange`.

**Stop** terminates the worker and closes its modal. Queued host calls are discarded, but an accepted write may finish. Starting again creates new UI handles; stored data remains. Navigation has the same cancellation boundary. Do not interpret cancellation or a lost reply as proof that a database write did not happen.

## Ownership and persistence {icon="database"}

A UI element belongs to at most one container. Reuse list action handles when updating rows; removing visible rows does not free their handles. `remove()` only clears UI data. `store.delete`, `opfs.delete` and database delete methods have separate storage effects.

| Storage | Shared with | Lifetime |
|---|---|---|
| Script variables and UI handles | Current run only | Until stop/restart |
| `kit.store`, `kit.opfs` | Pages of this app for this user on this browser/device | Until cleared; subject to browser storage policy |
| `kit.db` | All users with Use access to this app | Until explicitly reset/deleted |

Local storage is scoped to `kit/{appShortId}/{userId}/`, with separate `kv` and `files` areas. Disabling a shared database preserves its data. Deleting the app deletes its server database; local files cannot be erased remotely. Schema changes require App Admin; row operations require Use. There are no automatic per-row permissions.

Keep single-user apps simple. Add concurrency controls only for an actual conflict. Read-then-write is not atomic; sequential imports are not one transaction. For shared data, use constraints and refresh after writes instead of assuming no other user changed the data.

## Limits {icon="ruler"}

| Boundary | Limit |
|---|---|
| Project source / one file / files | 2 MiB / 1 MiB / 64 |
| UI nodes allocated per run | 300 |
| Table/list rows / table columns / select options | 1000 / 64 / 200 |
| UI text / ordinary UI id | 16000 / 80 characters |
| Local item / host data payload | 16 MiB |
| Concurrent accepted host requests | 32; processed sequentially |
| Runtime messages | 600 per one-second window |
| Console messages forwarded by host | 200 per run |
| Chart arrays combined | 1000 entries, including nested arrays |

Method-specific limits still apply. Table cells are strings, finite numbers, booleans or null; nested objects belong in your own data, not table cells. A layout exceeding limits or with invalid ownership stops the run. Short ids are six alphanumeric characters.

## Available today {icon="check"}

The reference describes the implemented API. No external package imports, direct worker network access, direct origin storage, OCR, arbitrary HTML, worker chart formatter functions or script i18n API are exposed. Relative static imports between project `.js` files are supported; `.md` files are documentation pages. Standard controls follow the Cloud language; your script's labels are your own text.
