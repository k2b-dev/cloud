---
title: Build Code in Gustav
navTitle: Gustav Code tools
section: Platform services
order: 968
description: Build, check, test and submit lasting Code in a Gustav conversation.
tags: [code, ai, sdk, versions]
updated: 2026-11-01
---

# Build Code in Gustav

Ask Gustav to build a schedule or edit existing Code. Gustav can prepare and
submit a checked version. Review and activate that version yourself in the UI
or CLI; the chat tools do not activate Code or change its access.

You need Code editor rights for every authoring tool, including reads and
comparison of resource-owned Code. Creating Code for a resource or application
requires administration of that owner. Authoring runs in an interactive chat;
background tasks cannot use these tools to edit lasting Code.

## Build and review a version

| Tool | What it does |
| --- | --- |
| `code_init` | Creates Code and returns its initial editable project. Omit `owner` for personal Code. |
| `code_pull` or `code_read({codeId})` | Returns the latest submitted files and `code.json` metadata, including `baseVersionId`. |
| `code_sdk` | Returns generated `@sdk` declarations, runtime, manifest and TypeScript configuration. |
| `code_write({project,path,content})` | Replaces one file in the supplied project and returns the complete replacement project. |
| `code_check` | Checks `{codeId,files,entry}` and lists permissions with source file and line. |
| `code_test` | Checks source and runs the supplied `test/NAME.json` fixtures against fake data. |
| `code_simulate` | Checks source and simulates one fixture with exactly one invocation. |
| `code_submit` | Checks and saves an immutable version against the supplied `baseVersionId`. |
| `code_diff` | Returns complete file differences and permissions for a submitted version. |

Draft writes stay in the conversation. Pass the replacement project into the
next write, and its files into check, test and submit. Pull retrieves submitted
files, so submit before relying on a later pull to recover an edit.

The permission list names each operation and target, where it occurs, whether
it is new or existing, and whether another target administrator is needed.
A missing display title is `null`; IDs still identify the target. A passing
check does not grant that permission.

Tests and simulation use a fixed clock, a seed and explicit fictional replies.
They never call real capabilities or create a durable run. See
[Test Code](/en/docs/platform/test-code) for fixture shapes. Runner failures
remain failures; source is never executed inside Core.

Keep the base version from pull or init. If someone submits another version
first, submit returns a conflict with the complete file comparison. Pull,
reconcile and check again. After an uncertain submit, pull to inspect the
latest version before retrying.

## Export data in one run

A one-off `code_run` can import the same generated capability SDK. It needs no
saved Code, version or owner, and its IDs may be dynamic. Default-export an
async function as with other script runs:

```ts
import { grids, sheet } from "@sdk";

export default async () => {
  const tableId = "t_fictional";
  const rows = await grids.table(tableId).record.list({});
  return sheet.toCsv(rows);
};
```

This example assumes the discovered operation returns an array of row objects;
use its actual result shape and pagination contract. SDK methods return domain
data directly. `sheet` uses the existing runtime spreadsheet helpers. Writes
still use the normal capability permissions and approval dialogs.

Studio apps keep their existing `code_read`, `code_write` and `code_check`
inputs with `id`, revision guards and screenshot review.

## Maintainer contract: shared CLI and chat JSON

Chat results use the same schemas and services as [cld code](/en/docs/platform/code-cli).
There is no chat-specific success wrapper. The contracts are
`codeAuthoringContracts`, `CodeAuthoringInput<K>` and `CodeAuthoringData<K>` in
`packages/core/src/code/authoring-contracts.ts`; `CodeProjectSchema`,
`CodeAuthoringPermissionSchema` and `CodeAuthoringErrorSchema` describe metadata,
permission rows and failures. Test and simulation reuse `CodeTestResultSchema`.
`codeAuthoringServices` owns execution of these commands for both transports.
