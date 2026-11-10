---
title: Find your API
navTitle: Find your API
section: Guides
order: 40
description: Each Cloud installation generates the SDK that Code imports from its own apps. Where to read it, and how handles, queries, actions, files and errors work.
tags: [code, sdk, capabilities, api]
updated: 2026-11-09
---

# Find your API

This page does not list what Code can call, because no list here would be
right for your installation. Each installation generates the SDK that Code
imports as `@sdk` from the apps it runs, including apps your organisation adds.
A new app or a new version of an app changes the SDK, and third-party apps
appear exactly like built-in ones.

SDK property segments use camelCase: `spaces.space(id).task.setCompleted`,
`grids.table(id).record.upsertExternal`, and `mail.mailbox(id).mailingList`.
This also applies to snake_case segments from Pulse and Venue. Capability
and event IDs keep their original spelling. Files imports as `files`;
its app and event IDs stay `filesv2` and `filesv2.*`.

## Where your installation tells you

| Where | What you get |
| --- | --- |
| `cld code sdk pull` | The typed SDK for one Code in its `sdk/` folder. Your editor completes every app, operation, input and result. |
| `code_sdk` in a Gustav chat | The same declarations. Gustav reads them before it writes a line. |
| `cld capabilities catalog` | Every app's capabilities; `--json` returns the complete manifests with inputs, results and policy. |
| `cld events ls` | The events Code can react to. |
| The Cloud [MCP server](/en/docs/platform/mcp) | Every live capability as a tool, and `cloud__events__list` for events. It does not hand out the Code SDK itself. |
| The **API Docs** app | The live OpenAPI references of the apps' HTTP APIs, for integrations outside Code. |

```terminal ~/work/code/mail/Mbx001
$ cld code sdk pull
SDK refreshed.
# sdk/ now matches this installation; open code.tsx and type "spaces."
$ cld capabilities catalog
# every app, its Queries and Actions, with descriptions and policy
$ cld events ls
# for example mail.message.received
```

The checker uses the server's current SDK, even when your local `sdk/` folder
is older. Pull again after an app update.

An agent outside Gustav, such as a coding agent in your terminal, works the
same way: it runs `cld code sdk pull` and reads the typed `sdk/` folder, and
it reads `cld capabilities catalog --json` for descriptions and policy.
Connected to the Cloud MCP server, it can also look up capabilities and events
there. To change Code, it uses the same `cld code` commands as a person.

## How calls work

Every app is one export of `@sdk`. Unless the app declares an SDK export
name, a hyphen in its app ID becomes an underscore: `work-shop` is `work_shop`.

**Handles select what an operation acts on.** `spaces.space("Spc001")` is a
handle for one Space; its methods are the operations that act on a Space.
Operations that act on no resource sit directly on the app, such as
`core.ai.generate(...)`. In resource Code, `owner` is the fixed handle of the
owning resource. A handle grants nothing: the app checks the account's rights
on every call.

**Queries return `{ data, page }`.** Read fields from `data`. While
`page.hasMore` is true, pass `page.nextCursor` using the declared continuation
input: usually `cursor`, or `after` for Files folder lists. Choose a page limit for the
loop: every page is one call of the run’s budget.

**Actions return their result directly.** Where an Action requires it, pass an
`idempotencyKey` derived from the business effect, such as a message ID. A
repeated key returns the first result instead of acting twice.

**Files travel as `FileRef`.** A read that returns a file gives the Code an
opaque reference, never bytes. Pass it to an Action with a `file` input, or to
`core.ai.generate` as `files`.

**Internet responses decode UTF-8.** `http.fetch()` returns `bodyBase64`
for binary bytes, `await response.text()` for text, and
`await response.json()` for parsed JSON.

**Schedules require a stable `name`.** Keep it when reordering registrations
so the automation keeps its identity.

**Errors are `CodeError`.** Compare `error.code`, such as `code_call_limit`,
never the message. `error.status` keeps a target's 403 and 404 apart.

## Three calls against built-in apps

Read rows from a Grids table with GQL, here a fictional base:

```ts
const { data: result } = await grids.base("Base01").gql.execute({
  query: "from table {Table01}\nselect {Field01} as name, {Field02} as stock\nlimit 50",
  pageSize: 50,
});
```

Create a record in a Grids table, once, even when the run is retried:

```ts
await grids.table("Table01").record.create({
  values: { Field01: "Desk lamp", Field02: 4 },
  idempotencyKey: "stock:desk-lamp:2026-11-09",
});
```

Create a task in a Space and read the Space's open tasks:

```ts
const space = spaces.space("Spc001");
await space.task.create({ title: "Order new chairs", idempotencyKey: "chairs:2026-11" });
const { data: open, page } = await spaces.task.list({ spaceId: "Spc001", status: "active", limit: 50 });
```

Discover real base, table, field and Space IDs through reads, never by
guessing. Each example is ordinary SDK use; which of them run unattended
depends on the policy described in [Control and security](/en/code/control).

## Write your own capability

An app author makes an operation callable from Code by declaring it as a
capability. The same declaration serves Gustav, the CLI, MCP and Code.
Read [App capabilities](/en/docs/platform/capabilities) to design one.

Reference: [Code SDK](/en/docs/platform/code-sdk),
[Read query results and follow cursors](/en/docs/platform/code-sdk#read-query-results-and-follow-cursors).
