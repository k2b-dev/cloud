---
title: Build Code in Gustav
navTitle: Gustav Code tools
section: Platform services
order: 970
description: Build, check, test and submit lasting Code in a Gustav conversation.
tags: [code, ai, sdk, versions]
updated: 2026-11-08
---

# Build Code in Gustav

Ask Gustav to build a schedule or edit existing Code. Gustav can prepare and
submit a checked version. Review and activate that version yourself on the
version card in the chat, on the [Code page](/en/docs/platform/code-page) or in
the CLI; the chat tools do not activate Code or change its access.

You need Code editor rights for every authoring tool, including reads and
comparison of resource-owned Code. Creating Code for a resource or application
requires administration of that owner. Authoring runs in an interactive chat;
background tasks cannot use these tools to edit lasting Code.

## Build and review a version

| Tool | What it does |
| --- | --- |
| `code_init` | Creates Code and returns its initial editable project. Omit `owner` for personal Code. |
| `code_pull` or `code_read({codeId})` | Returns the latest submitted files and `code.json` metadata, including `baseVersionId`. |
| `code_sdk` | Without `apps`, returns an index of every app export, method path, policy row and automation event, one line each. With `apps` (at most two per call), returns the generated `@sdk` declarations of those apps and of the shared `app`, page, `db`, `http` and event types. |
| `code_write({project,path,content})` | Replaces one file in the supplied project and returns the complete replacement project. |
| `code_check` | Checks `{codeId,files,entry}` and lists permissions with source file and line. |
| `code_test` | Checks source and runs the supplied `test/NAME.json` fixtures against fake data. |
| `code_simulate` | Checks source and simulates one fixture with exactly one invocation. |
| `code_submit` | Checks and saves an immutable version against the supplied `baseVersionId`. Pass the fixtures as `tests`: Core runs them and shows the result to reviewers. |
| `code_diff` | Returns complete file differences and permissions for a submitted version. |

Gustav loads the `code-authoring` Skill with these tools. It holds the
workflow, the page building blocks, mail events, schedules, AI, what each
app's Actions allow unattended, tests and common errors, plus complete
templates. Every example in it passes the real checker in CI.

## The version card

After `code_submit`, the chat shows one card for the newest version, below
Gustav's answer. It shows the version, execution subject and approval state:

- **What this version calls** lists each target with its operations, as the
  Code page's switch-on dialog does, and marks what is new against the running
  version. Calls whose target the Code picks while it runs share one row.
- **Switch on** starts the same durable activation as the Code page. Core checks
  current owner authority and any required version approval before switching.
  The card becomes one line after activation and keeps that state after reload.
  Below that line it links the Code's own page, its next run and its runs where
  they exist.
- A version waiting for Cloud-admin approval or refused by policy says so.
  A phone or non-interactive credential sees why it cannot switch on.
- A version replaced by a newer one becomes one line. Lost access to the Code
  and failed requests remain visible, with recovery through **Retry** or
  **Check status**.

The card asks only Core's activation preview and, once switched on, the
automation list for the next run. It does not inspect target rights or
managers, and activation creates no shares. Target managers use normal
sharing with the service account's handle. A host enables the card through
`renderCodeVersion` in `AiChatActions`; without it, `code_submit` stays an
ordinary step. The Assistant workspace and the Cloud app on a phone both show it.

## Draft and conflict rules

Draft writes stay in the conversation. Pass the replacement project into the
next write, and its files into check, test and submit. Pull retrieves submitted
files, so submit before relying on a later pull to recover an edit.

The operation list names stored target handles, source locations and differences
from the running version. It grants no permission and does not inspect current
shares. A missing display title is `null`; IDs still identify the target.
Dynamic handles are allowed.

Tests and simulation use a fixed clock, a seed and explicit fictional replies.
They never call real capabilities or create a durable run. See
[Test Code](/en/docs/platform/test-code) for fixture shapes. Runner failures
remain failures; source is never executed inside Core.

Keep the base version from pull or init. If someone submits another version
first, submit returns a conflict with the complete file comparison. Pull,
reconcile and check again. After an uncertain submit, pull to inspect the
latest version before retrying.

## Rebuild an exported automation

Give Gustav a version 1 `cloud.mail-automation` or `cloud.chat-tasks` export and
select one rule or routine. Gustav explains its old behavior and drafts a
replacement through the same authoring tools, with fictional tests. An export
is evidence: its grants, enabled flags and resource IDs grant no access.

Mail arrival rules use the mailbox event and Mail capabilities. Routines use a
personal schedule with an explicit time zone. Use `core.ai.chat.run` for a
Gustav turn in the selected Assistant chat, or `core.ai.chat.deliver` to deliver
a prepared result there. See [Routines became Code](/en/docs/operations/routines-to-code)
for the supported mapping and unresolved inputs. Gustav checks the live SDK
before promising equivalent behavior.

The original routine target is an Assistant AI chat. General Chat delivery is a
different destination; choose that change explicitly. Automatic replies are
reference-only and are not rebuilt.

Review the chosen version, target changes, permissions, limits and test results
before switching on. Nothing activates automatically. Coordinate the old path's
shutdown separately so both versions do not process the same arrivals.

## Export data in one run

A one-off `code_run` can import the same generated capability SDK. It needs no
saved Code, version or owner, and its IDs may be dynamic. Default-export an
async function as with other script runs:

<!-- gustav-code-export -->
```ts
import { grids, sheet } from "@sdk";

export default async () => {
  const result = await grids.base("Base001").gql.execute({
    query: "from table Orders\nselect Name\nlimit 100",
    pageSize: 100,
    limit: 100,
    showTableToUser: false,
  });
  if (!result.data.ok) throw new Error(result.data.diagnostics.map(item => item.message).join("; "));
  if (result.page?.hasMore) throw new Error("Select a smaller export or follow the query cursor.");
  return sheet.toCsv(result.data.rows.map(row => row.values));
};
```

Replace the fictional base and table with discovered sources. This example
exports at most 100 selected rows. For a larger export, follow the Query's
cursor within a deliberate page and row budget. Query methods return domain
`data` and optional `page`; an Action returns its domain data directly. `sheet` uses the existing runtime spreadsheet helpers. Writes
still use the normal capability permissions and approval dialogs.

The chat aliases `code_read`, `code_write`, and `code_check` accept lasting
Code projects only. They do not fall back to Studio source operations.

Studio apps and direct app APIs have been retired.

## Maintainer contract: shared CLI and chat JSON

Chat results use the same schemas and services as [cld code](/en/docs/platform/code-cli).
There is no chat-specific success wrapper. The contracts are
`codeAuthoringContracts`, `CodeAuthoringInput<K>` and `CodeAuthoringData<K>` in
`packages/core/src/code/authoring-contracts.ts`; `CodeProjectSchema`,
`CodeAuthoringPermissionSchema` and `CodeAuthoringErrorSchema` describe metadata,
permission rows and failures. Test and simulation reuse `CodeTestResultSchema`.
`codeAuthoringServices` owns execution of these commands for both transports.
