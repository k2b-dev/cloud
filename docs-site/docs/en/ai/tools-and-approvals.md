---
title: Tools and approvals
navTitle: Tools and approvals
section: AI
order: 1040
description: Let models request application actions while keeping authorization and approval explicit.
tags: [ai, tools, approvals]
updated: 2026-10-09
---

# Tools and approvals

A tool gives the model a named action with validated input and output.

The model may request the action. Cloud still controls where it runs, whether
approval is required, and which actor reaches the implementation.

Capability results can include optional [table presentation metadata](/en/docs/platform/capabilities#optional-table-previews).
Assistant displays the referenced canonical values directly; the model does not
generate a separate table payload. This metadata grants no authority and remains
optional for CLI and programmatic clients.

Applications can also restrict launched conversations through
[`allowedTools`](/en/docs/ai/chat-runtime-and-streaming). The stored ceiling applies
to later turns and forks as well as initial discovery. Action approval and domain
permissions still apply to every permitted operation.

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
| `.clientView()` | Cloud answers the call itself; the chat only shows it |
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
The person remembers it either for the current chat, the default, or always. A
chat approval ends when the chat is deleted. Only use a shared scope when every
call covered by it has the same consequence.

A server tool that asks for something narrower than itself names it with
`context.requestApprovalFor(message, { toolName, approvalScope, always })`
instead of `context.requestApproval(message)`. The approval card then offers to
remember that target, never the tool. Code Mode uses this for the HTTP
requests and Capability Actions of a code run. The tool looks up remembered
approvals for its target itself, so AI Core does not.

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
as with surveys, the long-form text editor, charts, or presented files. Keep
operation details and arguments in the tool description and schema; the hint
does not replace either.

The built-in `chart` tool is a `clientView()` that shows one chart in the chat
from data the model already has. Its input is the plain-data form of
`cloud.chart()` in Studio code: `bar`, `line` (with `area` to fill it),
`scatter`, `pie`, `donut`, `histogram`, `gauge`, or `sparkline`, with `title`
and an optional `subtitle`, but without `width`, `height`, or `format`
functions. Model providers accept only an object at the root of a tool schema,
so `CloudAiChartInputSchema` describes every kind as one object whose fields
name the kinds they belong to, and checks the rules of the chosen kind after
that. A chart holds at most 8 series, one per palette color, and at most 480
values per list, one per unit of the 480-unit drawing. `x` is a number, a date
`YYYY-MM-DD`, or a local date and time `YYYY-MM-DDTHH:mm` or
`YYYY-MM-DDTHH:mm:ss` without an offset, written in the user's time zone.

The schema checks these bounds first: input outside them fails before anything
is computed or drawn. It then rejects input that would not draw as written: a date that does not exist, such as February 30; a line with
fewer than two points in a series; values at or below zero on a `log` axis,
which the chart would leave out; values outside an axis `domain`; values that
differ too little for their size to label an axis, such as 1e17 and 1e17 + 16;
pie slices that add up to zero; or a pie whose legend leaves too little room
for it. The model gets the reason, and the chat never shows a broken chart or a
table that hides a value. `parseCloudAiChartInput()` reads the arguments of a
call as one typed chart without drawing it.

Cloud answers a chart call itself, without a browser and also in background and
scheduled runs, whose transcript shows the chart later. The call goes from
running to completed without an open request in between. The chat draws it
with the `@k2b/ui` chart renderer that `cloud.chart()` uses. The chart has no
code, sandbox, state, or actions. The reader can switch it to a data table that
shows and copies every value as given, and axis labels show fractional values
exactly. When a chart needs filters or buttons, Assistant shows an app in the
chat with `code_present` instead; data that must be kept or an app that is used
again becomes a saved Studio App.

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
executable operations. The tools query the shared PostgreSQL Help service when called. A Help failure
stays local to that call and may be retried. Use concise search terms in the
request language; optional BM25 improves ranking without adding tools. The
tools search and read as the chat's user, so they never return Help of an
application that user may not see. See
[In-product Help](/en/docs/platform/help) for the owning declaration and
[who can read Help](/en/docs/platform/help#who-can-read-help).

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
  need a search call merely to translate an already known tool. It also accepts
  the provider name of an app operation, such as
  `mail__query__conversation_dot_list`, which a model may have seen in an
  earlier call. Its result lists `loaded` and `alreadyLoaded` tools as
  `{name, call}`, where `call` is the name the model calls the tool by, and
  every other requested name under `unavailable` with one reason:

  | Reason | Meaning |
  | --- | --- |
  | `unknown` | No tool has this exact name, or it names an optional built-in that is off, such as `memory` while memory is disabled |
  | `not_offered_in_turn` | The tool exists, but this turn's client or task does not provide it, or the turn offers no app operations |
  | `not_allowed` | The conversation's fixed tool scope or task grants exclude it |
  | `app_offline` | The operation was loaded earlier, or the registry cannot be read, and its app is not in the live registry now |

  The model looks up an unknown name once with `search_tools` and does not
  search for or retry the other three in the same turn;
- `list_apps` returns a bounded map of exact app IDs to their live descriptions
  when the owning app is unclear.

Background runs use the task's mandate policy and grants for `search_tools`,
`load_tools`, `list_apps`, and resource readers. Tools outside that scope stay
unavailable even if the interactive chat loaded them earlier. When the scope
allows no app operations, `search_tools` says so instead of reporting an outage.
Fixed inputs are checked per call; a rejected call returns a tool error the
model can recover from. Broken authority or required interaction still makes
the task need attention; see [Background mandates](/en/docs/identity/background-mandates#grant-capabilities-to-an-unattended-assistant-task).

A loaded built-in or app operation becomes an ordinary named tool on the next model turn.
Cloud gives the model the operation's structure, required fields,
descriptions, enums, and useful formats. The provider remains responsible for
authoritative input validation and the complete result contract. A call to a
loaded app operation by its capability ID runs under its provider name. A call
to any other name the turn does not offer fails, and the model reads how to
find a callable name. If an operation disappears from the live catalog, AI Core
names it in the `search_tools` description and does not infer a replacement.

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

Loaded-tool state and remembered approvals store qualified capability IDs and
stable built-in names, never credentials or private contracts. Cloud generates
a provider-safe callable name when preparing a model request. Model message
history stores each call under its provider-safe name, and the `call` field of
a `load_tools` result carries that name. Code that reads stored tool calls
accepts both the capability ID and the provider name.
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
| Action without `approval` | Require fresh approval for that call; it cannot be granted to a scheduled task |
| Action with `approval: "rememberable"` | Offer one-time approval, **Approve for this chat**, or **Always approve** for the app-owned review scope |

Capability manifests describe objective Action properties such as `openWorld`,
`destructive`, idempotency, and the optional availability of a review. AI Core
uses the canonical app-owned scope returned by a rememberable Action's live
review for the concrete arguments. A remembered choice matches the current
actor, qualified Action, and exact scope, and a chat choice also the chat. AI
Core never infers a broader scope from an attachment, resource ID, or
presentation metadata. A review that returns no `approvalScope` for particular
arguments makes that call ask every time, for example a copy into another
storage base.

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
belongs directly in the review card. Approving once stays the primary action.
When the owning Action supplies a reusable scope, the menu offers
**Approve for this chat** first and **Always approve** after it
(`remember: "chat"` or `remember: "always"`). A pending approval carries
`allowChat` and `allowAlways`; for a website it also carries `website`, the
exact origin a chat approval would allow.
When a Capability review is available, show it instead of making the user
interpret opaque IDs in the raw arguments. Review details default to the
compact `inline` presentation; `display: "block"` gives long plain-text values
their own bounded section. Apps can mark canonical `YYYY-MM-DD` values as
`date` and RFC 3339 instants as `date-time`; the shared UI renders them for the
viewer without changing the persisted value. These hints never enable HTML or
Markdown rendering, and semantic review links remain clickable same-origin
links.

The owning app sets this policy in its manifest. Users and administrators
cannot loosen it; a user can only remember an approval where the Action offers
it. Users can list and revoke the choices that apply everywhere under
**Assistant settings > Approvals**, and those of one chat under
**Secrets & approvals** in the chat's context panel
(`GET /api/ai/approval-preferences?conversation=<chat>`). Revocation is
ownership-scoped and takes effect on the next matching call. A scheduled task
or mandate never uses a remembered approval; it runs only on its own grants.

### Allow a website for a chat

Code Mode's `cloud.http.fetch` asks for every request by default. When a
request only reads, the card offers **Allow this website for this chat**. A
request only reads when it uses GET or HEAD without a body and without any
header, which also rules out a secret. Cloud derives the website from the
stored request on the server, never from the model or the browser.
Afterwards, requests in this chat are allowed without asking only if all of
these hold:

- the request has the exact same origin, so scheme, host, and port match;
- it is GET or HEAD without a body, custom headers, or secret references;
- a person started the turn in a signed-in browser session, not a scheduled
  task, a mandate, `cld`, an API key, or another delegated credential;
- the code is the chat's own code or a Studio app the person manages, never an
  app they only use or HTML presented in the chat.

Website approvals are never offered as **Always**. `cld`, an API key, or
another delegated credential may approve the single request, but cannot
remember the website. Each request let through this way appears in the chat as
a receipt with its full URL, query included. The receipt and the chat's
**Secrets & approvals** dialog both revoke it with one click. The
remembered-approval name is the reserved `website:read`, which no tool or
Capability can use.

A Studio app the person manages gets the same choice in its request dialog as
**Allow this website for this app**. That approval lasts until it is revoked
or the app is deleted. Each request it lets through shows a notice with the
full URL and a **Revoke** action. The app's **Secrets & approvals** dialog
lists these approvals.

The operator of an allowed website still sees every full address the code
requests, including the query, which may carry data from the chat. Approve
only websites you would let read what the chat contains.

### Read web pages with provenance

`web_search` never asks. `web_extract` and `fetch_file` read an address
without asking only when the chat supplied it: the person wrote it,
`web_search` returned it, or a page read earlier links to it. Any other
address, such as one the model built from other data or found in a mail, shows
an approval card with the full URL and the same website choice as an HTTP
request. A refused read fetches nothing. A scheduled task cannot ask, so such
a read fails there.

See [Resource authorization](/en/docs/identity/authorization) for the domain
permission check.

Server tools may await `context.reportProgress?.(message)` to publish a short,
localized status in the active tool row. Report phase changes rather than every
poll. This status is presentation only: do not include payloads or secrets, and
continue to return the authoritative result from the tool.

## Maintain a chat working plan

`todo_write` is an immediately available server tool for multi-step work. It
replaces the complete plan with `{todos:[{id,content,status}]}` and returns that
validated plan. IDs stay stable when tasks are renamed or reordered. Status is
`pending`, `in_progress`, `completed`, or `cancelled`; at most one item may be
active. An empty list clears the plan. Plans allow up to 50 short tasks, each
with at most 500 characters, to keep the working context bounded.

The runtime stores successful updates as normal tool results in the originating
conversation. Failed calls do not replace the plan. Snapshot reads include the
latest checkpoint independently of history pagination. Compaction preserves an
exact plan checkpoint alongside its summary; fork and retry follow the selected
history rather than importing a later plan. A plan records intended and completed
work; it neither executes actions nor grants permission.
