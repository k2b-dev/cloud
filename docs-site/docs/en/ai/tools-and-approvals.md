---
title: Tools and approvals
navTitle: Tools and approvals
section: AI
order: 1040
description: Let models request application actions while keeping authorization and approval explicit.
tags: [ai, tools, approvals]
updated: 2026-08-23
---

# Tools and approvals

A tool gives the model a named action with validated input and output.

The model may request the action. Cloud still controls where it runs, whether
approval is required, and which actor reaches the implementation.

## Define a server tool

```ts
import { defineAiTool } from "@k2b/cloud/ai";
import { z } from "zod";

export const archiveItem = defineAiTool({
  name: "archive_item",
  description: "Archive one inventory item.",
  inputSchema: z.object({
    itemId: z.string().uuid(),
  }),
  outputSchema: z.object({
    archived: z.boolean(),
  }),
  approval: "once",
  timeoutMs: 10_000,
  promptHint: "Use this when the user asks to archive an item.",
  toHistoricalResult: ({ output }) => output,
}).server(async ({ itemId }, { actor, signal }) => {
  await authorizeArchive(actor, itemId);
  await archive(itemId, { signal });
  return { archived: true };
});
```

The implementation receives the current request actor, abort signal, and
conversation ID.

Always authorize inside the tool. Approval confirms user intent. It does not
grant domain permission.

## Choose where it runs

| Builder | Execution |
| --- | --- |
| `.server(run)` | Cloud runs the implementation |
| `.client()` | Browser handles the call |
| `.clientView()` | Browser handles a view-only interaction |
| `.clientInteraction()` | Browser handles an interactive action |

Register browser handlers with `createAiChatController({ frontendTools })`.
Submit the result through the controller. The runtime validates it against the
tool output schema before continuing.

Use a server tool for domain reads and writes. Use a frontend tool only when
the action requires browser state or direct user interaction.

### Run an optional tool in a local CLI

The interactive Assistant CLI may opt one turn into the predefined
`local_bash` client tool with `cld assistant --allow-bash`. AI Core persists
the tool call and its result, but it never executes the command. The CLI shows
the exact command and asks for confirmation before starting `/bin/bash` as the
current OS user in the CLI's startup directory.

The Assistant web app does not advertise or execute this tool. It still shows
persisted local Bash calls and results in conversation history. A pending call
is read-only there and can be continued only by an opted-in local CLI.

Local command output is stored with the conversation and sent to the selected
model. Treat retrieved mail, webpages, files, and tool output as untrusted:
`--allow-bash` exposes the tool for the session, but never approves an
individual command. There is no remembered or non-interactive Bash approval.

## Set the approval policy

This policy belongs to tools declared with `defineAiTool()`. Dynamically loaded
app Capability Actions use the fixed AI Core policy described below.

| Policy | Behavior |
| --- | --- |
| `never` | Executes without an approval prompt |
| `once` | Requires approval for each call |
| `always` | Allows the user to remember approval |
| `{ kind: "user-configurable", default, scope }` | Uses a configurable default and optional shared scope |

The default is `once`.

Remembered approval is scoped to the actor, tool, and declared approval scope.
Only use a shared scope when every call covered by it has the same consequence.

Use `never` only for safe reads or deterministic presentation. Writes and
external side effects should require approval.

## Tool contracts

Use Zod schemas that contain only data required for the action.

Set `timeoutMs` for bounded work. Pass the abort signal to downstream calls.

Use `toHistoricalResult` when a full tool result is useful now but too large to
send to the model in later loops. Cloud still persists the full result for the
user.

Cloud sizes current-loop tool results from the selected model's context window,
up to the operator-configured ceiling. Large-context models can therefore use
substantial web extracts and file slices, while models without a known context
window use a conservative fallback. Tool-specific safety and transport limits
still apply, and historical projections stay compact for later loops.

`promptHint` adds one short usage nudge to the system prompt. Use it when the
model could finish with plain text but Cloud prefers the tool-backed experience,
as with surveys, the long-form text editor, or presented files. Keep
operation details and arguments in the tool description and schema; the hint
does not replace either.

The built-in `text_editor` is a `clientInteraction()` for one complete
plain-text or Markdown draft of at most 20,000 characters. It is appropriate
when the user should revise substantial text before the model continues. The
browser keeps unsubmitted edits only in local component state, so reloading may
restore the original tool input. The user can accept the edited source or send
feedback without accepting it; after feedback, the model should revise the
original and present the complete replacement with `text_editor` again. A
submitted result is durable, but it only returns reviewed text or revision
feedback; writing a Mail draft, changing a Note, or sending a message remains a
separate authorized Capability Action with its own approval.

`view_image` is a safe read over one authorized conversation or read-only
Project file. Its input is an absolute file path and optional bounded guidance;
Project files are mounted below `/project`. Cloud validates the image type and
size, invokes the selected model when it supports Vision or the
administrator-selected Vision tool model otherwise, and returns a bounded
description. Image contents remain untrusted data. Without either usable Vision
path, the tool reports that image inspection is unavailable.

`fetch_file` is an always-loaded safe read that imports one exact public HTTPS
file into the private conversation. It sends no cookies, credentials, or
authorization headers. Cloud resolves and pins a public network address,
repeats that check for every bounded redirect, and enforces both declared and
streamed byte limits. The result is an assistant-owned conversation file below
`/imports`; inspect it with `read_file` or `view_image`, then use `present` when
the user should receive the original file. The tool does not clone or browse a
repository, authenticate to a website, or reach private network targets.
Download failures appear as a short category such as **File not found**,
**Authorization required**, or **File server error**, followed by an actionable
explanation; the activity disclosure retains the requested URL and full tool
response for diagnosis.

## Search product Help

A user-backed personal chat on a tool-capable model resolves `search_help` and
`read_help` dynamically from app-owned Help registration. They do not require
Capability discovery because static product guidance is separate from
executable operations. A registry failure stays local to Help and may be tried
again on a later model turn. See
[In-product Help](/en/docs/platform/help) for the owning declaration and
exposure rules.

## Discover and load tools

A personal chat uses the live capability catalog through its default tool
source:

```ts
toolSource: { kind: "default", appTools: true }
```

Tool-capable personal chats keep three bounded discovery tools available:

- `search_tools` searches Cloud built-ins and live app operations by task. App
  operations use their stable qualified capability ID, such as
  `mail.conversation.list`. Its
  optional `appId` scopes app operations; `kind` is returned as metadata and is
  not a search filter. Searching never loads a tool;
- `load_tools` retains qualified capability IDs or stable built-in names.
  Skills and the system prompt may name either directly, so the model does not
  need a search call merely to translate an already known tool;
- `list_apps` returns a bounded map of exact app IDs to their live descriptions
  when the owning app is unclear.

A loaded built-in or app operation becomes an ordinary named tool on the next model turn.
Cloud gives the model the operation's structure, required fields,
descriptions, enums, and useful formats. The provider remains responsible for
authoritative input validation and the complete result contract. If an
operation disappears from the live catalog, AI Core treats it as temporarily
unavailable rather than inferring a replacement.

Capability providers may add the fixed result envelope's optional `summary`
when one short statement communicates the successful outcome better than raw
data. AI Core stores and displays that provider-authored text together with
semantic refs and links. It does not ask the model to supply a second
explanation of its own call.

Assistant keeps ordinary technical tool details collapsed by default. Result-
first experiences such as web sources, presented files, image
inspection, surveys, and the text editor remain directly visible or expanded.

Discovery is not authorization. Every invocation resolves the conversation's
current user, creates a short-lived request delegation, and lets the owning app
authenticate and authorize the operation again. Cloud never persists or
replays the user's browser cookie, bearer token, resource API key, or service
account credential for this path. An unavailable app or denied resource fails
that tool call without granting fallback access.

The chat stores qualified capability IDs and stable built-in names, not
provider-encoded function names, credentials, or private contracts. Cloud
generates a provider-safe callable name only when preparing a model request.
When a result contains a semantic `open` or `edit` link, clients use
that exact path instead of inferring a route from a resource ref.

Never retry `ACTION_OUTCOME_UNKNOWN`. `INVALID_APP_RESPONSE` and `INTERNAL`
indicate a provider defect. Do not retry the same capability with unchanged
arguments; report the failure so the app can be fixed. Input validation and
schema mismatch errors may be corrected or refreshed according to their
structured error code.

The full provider declaration, schema, result, compatibility, and transport
contract lives in [App capabilities](/en/docs/platform/capabilities).

### Approve Capability Actions

AI Core treats capability operation kinds as the approval boundary:

| Capability kind | AI Core behavior |
| --- | --- |
| Query | Execute without interactive approval |
| Action without `approval` | Require fresh approval for that call |
| Action with `approval: "rememberable"` | Offer one-time approval or **Always approve** for the app-owned review scope |

Capability manifests describe objective Action properties such as `openWorld`,
`destructive`, idempotency, and the optional availability of a review. AI Core
uses the canonical app-owned scope returned by a rememberable Action's live
review for the concrete arguments. A remembered choice matches the current
actor, qualified Action, and exact scope. AI Core never infers a broader scope
from an attachment, resource ID, or presentation metadata.

For example, the single-file and atomic multi-file Assistant Skill reference
Actions offer **Always approve** in the split-button menu after their
full-content review. That choice applies to later writes through the same
Action across all Skills the current user can edit. Every write still rechecks
Skill access, validates the complete Markdown files, and enforces the expected
revision. A multi-file write validates the whole batch first and advances the
revision once; deleting a reference continues to require a fresh approval.

This approval confirms the user's intent for one model-requested call. It is
not application authorization. After approval, the owning app validates the
same arguments and checks current resource access and domain invariants before
performing the Action.

### Show an optional Action review

An Action may publish the fixed optional
[capability review](/en/docs/platform/capabilities#describe-an-action-before-it-runs).
After the model requests such an Action, AI Core resolves the review with the
current user and the same arguments before presenting the approval.

The review is UI-only. Cloud renders its bounded message and details as escaped
plain text, with same-origin links in the approval footer. It is never added to
model context or returned as a tool result.
The app name, icon, Action title, and risk treatment continue to come from the
live registry and manifest. Once presented, the resolved review is stored with
the pending action and active-turn snapshot; reconnecting or reopening the chat
must render that same snapshot rather than recomputing or degrading it.

If no review is advertised, the approval shows the validated Action arguments.
If an advertised review fails, Cloud does not silently fall back to the weaker
display and does not execute the Action. The user may retry after the app or
resource becomes reviewable again.

A review does not alter arguments, grant permission, record consent, or replace
an app-owned safety workflow. For example, a domain fingerprint or optimistic
revision required by an Action remains part of the Action input and is enforced
again by the owning app.

## Handle approval in the UI

The stream exposes pending actions. The shared controller provides:

- `respondToApproval({ turnId, callId }, { approved, remember })`;
- `submitFrontendToolResult({ turnId, callId }, result)`.

Show the tool name, requested inputs, and consequence before approval. The
primary action uses a split button; its **Details** item toggles the complete
validated arguments for technical verification. Do not require ordinary users
to read that raw representation: every value needed for an informed decision
belongs directly in the review card. Approving once stays the primary action;
when the owning Action supplies a reusable scope, **Always approve** remains an
explicit secondary choice.
When a Capability review is available, show it instead of making the user
interpret opaque IDs in the raw arguments. Review details default to the
compact `inline` presentation; `display: "block"` gives long plain-text values
their own bounded section. Apps can mark canonical `YYYY-MM-DD` values as
`date` and RFC 3339 instants as `date-time`; the shared UI renders them for the
viewer without changing the persisted value. These hints never enable HTML or
Markdown rendering, and semantic review links remain clickable same-origin
links.

Users can list and revoke their remembered choices in Assistant under
**Personalization → Approvals**. Revocation is ownership-scoped and takes
effect on the next matching call.

See [Resource authorization](/en/docs/identity/authorization) for the domain
permission check.
