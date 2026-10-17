---
title: Tools and approvals
navTitle: Tools and approvals
section: AI
order: 1040
description: Let models request application actions while keeping authorization and approval explicit.
tags: [ai, tools, approvals]
updated: 2026-10-12
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
| `.client()` | A connected client handles the call |
| `.clientView()` | Cloud answers the call itself; the chat only shows it |
| `.clientInteraction()` | Browser handles an interactive action |

Register browser handlers with `createAiChatController({ frontendTools })`.
Submit the result through the controller. The runtime validates it against the
tool output schema before continuing.

Use a server tool for domain reads and writes. Use a frontend tool only when
the action requires browser state or direct user interaction.

### Run an optional tool in a local CLI

Local clients such as interactive `cld assistant` declare the tools they can
run through `clientToolIds`. Cloud declares their input and output schemas,
persists requests and results, and validates each result before continuing.
The client executes them, enforces workspace path rules, and asks the user
when a path or operation requires a decision. Cloud never reads the local
filesystem or executes a local command itself.

| Tool | Purpose |
| --- | --- |
| `local_list` | List local files and folders, optionally by glob, in pages; unreadable subfolders are skipped and named |
| `local_read` | Read local text with line numbers; upload documents and images for Cloud tools |
| `local_upload` | Upload local files into this chat and return chat paths |
| `local_download` | Save a chat file to a new or replaced local file |
| `local_write` | Create, append to, or replace a local text file |
| `local_move` | Move or rename local files and folders without overwriting |
| `load_local_skill` | Load a local Skill's instructions, directory and file list |
| `local_bash` | Run a command as the user's OS account in the workspace |

Local tool decisions are never remembered as Cloud approvals. The client
controls its questions; a completed call does not prove the user saw it.
Calls and results become chat history and are sent to the model. Retrieved
files and ordinary tool output remain untrusted data. Upload local files with
`local_upload` before using a chat path with `read_file`, `view_image`, or Code
Mode. The web app displays local tool history but does not offer or execute
these tools. See [cld assistant](/en/apps/cld/assistant) for local tools modes,
path rules and terminal questions.

Cloud approvals in cld use numbered **Approve once**, **Approve for this
chat**, and **Always approve** choices where allowed; Enter rejects. When only
one-time approval is available, the prompt uses `y/N`. Typed-ahead or pasted input never answers these questions.
Websites cannot be remembered from cld. `/approvals` and `cld assistant
approvals list|revoke` list and revoke remembered approvals, including websites
saved in the web; `list --chat <chat-id>` selects approvals limited to that chat.

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
approvals for its target itself, so AI Core does not. A tool that lets a
request through on a remembered website approval reports it with
`context.reportWebsiteReceipts([{ index, method, url }])` before the request
goes out. The chat records each receipt on the call, so it stays visible
whether the call succeeds, fails, or its turn stops; a receipt reported again
with the same `index` replaces itself.

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

The built-in `card` tool shows one highlight figure the model already has as
one stat tile, the same look as a stats view. `tone` is accepted but not shown,
and the trend stays neutral because a card does not say whether up is better.
Its title, value, caption and trend wrap instead of being cut off; the tool
asks for a short value of about 20 characters and a one-line caption.
Several figures computed in `code_run` belong in `cloud.view.stats` in that
run, followed by `present({path})`.

The built-in `chart` tool is a `clientView()` for a few values the model already
has that did not come from a code run. It shares the chart contract of
`cloud.chart()` in Studio code, without `width`, `height`, or format functions.
Set exactly one of `kind` or `charts` at the tool's flat root, with `title` and
optional `subtitle` (unit, period or source).

In Studio and one-off HTML apps, `cloud.chart()` shows tooltips by default on
hover, keyboard focus and tap, using the same text as chat charts and their data
tables. Function formats also apply to tooltip values when `tooltip.format` is
absent.

Printed pages and PDFs (`cloud.pdf.render`, presentation PDF download and
browser print) list the chart's values in a table below it, hidden on screen.
The table is complete with no extra row limit; PDF size grows with the number
of points.

| Kind | Data and options |
| --- | --- |
| `bar` | `data: [{label, value}]`; `yAxis`, `colorByBar`, `showValues`, `legend`, `references` |
| `line`, `scatter` | `series: [{label?, data: [{x, y}], role?}]`; `xAxis`, `yAxis`, `legend`, `references`. Line also accepts `area`, `smooth` and series `style`. |
| `pie`, `donut` | `data: [{label, value}]`; `legend`, `showLabels`, `format` |
| `histogram` | `data: number[]`; `bins` (count or ascending edges), `references` |
| `gauge` | `value`; `min`, `max`, `label`, `unit`, `format`, `thresholds` |
| `sparkline` | `data: number[]`; `area` |
| `boxplot` | `data: [{label, values: number[]}]`; `yAxis`, `references` |
| `heatmap` | `data: [{x, y, value}]`, with text categories and each x/y pair once; at most 17 rows (y categories), and column labels that fit a phone-wide chart; `min`, `max`, `showValues`, `format` |
| `barGauge` | 1..8 `data` items `{label, value, min?, max?}`; labels at most 10 characters. Optional shared `min`, `max`, `unit`, `format`, `thresholds`. |
| `stat` | `value`; `format`, `unit`, `delta` (change in the value's units), `better: "up" | "down"`, `sparkline: number[]` |

Axes accept `label`, `domain: [min, max]`, `ticks` (2..12), `scale: "linear" |
"log"` and `format`. Number formats are `{style?: "number" | "percent" |
"currency", currency?, unit?, decimals?, compact?}`. Currency requires an
uppercase three-letter code exactly when style is currency; percent takes
fractions, decimals is 0..10, and unit is a suffix of at most 12 characters.
Date x axes take `{date: "day" | "minute" | "second"}`. With `showValues` on
bars, y ticks use the value format. Pie and donut slices show shares, so their
format applies to the values in tooltips and the data table.

Every chart kind accepts `tooltip: {label?, format?}`; groups do not. `label`
names the numeric value or y column in the data table and tooltips, ahead of
an axis label. `format` takes the number format above, without date
formats, and overrides value cells and tooltips. Counts, shares, x values and
axis ticks keep their own formats. For example,
`tooltip: {label: "Umsatz", format: {style: "currency", currency: "EUR"}}`
shows `1.200,00 €` for 1200 in German. A kind's `unit` remains appended.

`references` holds at most 8 `{value, axis?, label?}` lines, defaulting to y.
Only line, scatter and histogram accept x references. Reference values match
the axis type; automatic domains include them, and explicit domains must contain
them. Gauge and barGauge `thresholds` hold 1..8 `{value, label?}` bounds in
strictly ascending order within every effective min..max range (defaults 0..100).
Cloud uses palette colors for bands. Line series `style` is `solid`, `dashed` or
`dotted`; `role: "reference"` defaults a line to dashed unless style is set,
and makes scatter points hollow in chat. For stat, `better` lets the host choose
the change color; absent `better` or a zero change is neutral.

A group takes `charts` (2..6 complete chart specs), optional `linkX` and
`layout: "stack" | "grid"` (default stack). `linkX` requires line charts whose
x values are all numbers or all dates. There is no second y axis; use a group
for related measures with different units. Groups are separate charts, not
grouped or stacked bars; neither bar mode is supported
([upstream issue](https://github.com/k2b-dev/stdlib/issues/5)). See
[Chat interface](/en/docs/ai/chat-interface) for layout and cursor behavior.

Limits are 8 series and 480 values per series or ordinary data list. Boxplots
allow up to 480 groups; their observations count toward the 3,840-mark budget.
Heatmaps allow up to 3,840 cells. Each chart and each group has a total budget of
3,840 input marks, including boxplot observations and a stat's headline plus
sparkline. A line or sparkline needs at least two points; scatter needs one.
x values are finite numbers or `YYYY-MM-DD[THH:mm[:ss]]`, wall-clock time without
an offset. All series in a chart use the same x type.

The schema checks bounds before computing or drawing. It rejects nonexistent
dates, values at or below zero on a log axis, values outside an explicit domain,
values too close for their size to label an axis, zero-total pies and legends
that leave too little room for a pie. Heatmap column labels must fit a phone-wide
chart; validation names the allowed length or asks for fewer columns. The model
gets the reason. `parseCloudAiChartInput()` reads one chart without drawing;
`parseCloudAiChartToolView()` reads either a chart or a group.

Cloud answers chart calls without a browser, also in background and scheduled
runs. The transcript shows them later. Readers can switch each chart to its
data table and use Copy data. Filters, steps and comparison over computed rows
use `cloud.view.explorer` in `code_run`. Anything else the person interacts
with, such as a calculator, converter, timer or form, is a saved Studio App
created with `code_create`, even when it keeps no data.

Computed results stay in `code_run`: the script calls `cloud.view.chart`,
`cloud.view.group`, `cloud.view.table`, `cloud.view.stats`,
`cloud.view.details` or `cloud.view.explorer`, then the model calls `present({path})`
for each view the person should see. It never retypes run values into chart
arguments, app data or Markdown. A missing view requires another run with
`cloud.view.*`.

Views are declarative JSON chat files under `/views/*.view.json`, validated on
every server write. Chart views use the contract above; group views are
`{view: "group", title, subtitle?, charts, linkX?, layout?}`. Code runs may use
rows convenience forms for chart specs, including each chart in a group.
Tables have unique typed columns, rows, an optional footer and initial sort;
number columns use the same number formats. A `ref` column holds Cloud
references or null; every other column requires its declared scalar type.
Stats show 1..6 comparable key figures above charts, instead of several card
calls or stat charts. Details show 1..100 exact fields of one record, such as a
checked invoice, as read-only rows. Views contain no markup or functions;
labels and cells render as text. Limits are 3,840 table rows, 100 columns and
1 MiB per view; views and downloads share 64 outputs per run. Model write tools
reject `/views` paths. Users retain file editing, download, rename and deletion
rights.

A saved stats view is `{view: "stats", title, subtitle?, items}`. Each item has
`label` and `value` (a finite number, or short text for a state such as `"OK"`),
optional number `format`, `sub`, finite `delta`, `better: "up" | "down"`, and
`sparkline` (2..480 finite numbers, oldest first). Format and delta require a
numeric value; better requires delta. Delta is in the value's units. The host
chooses improvement colors from better; no direction or zero stays neutral.
Titles are trimmed to 1..160 characters, subtitles to 1..300, and item labels,
text values and sub to 1..80. Stats do not convert Dates.

A saved details view is `{view: "details", title, subtitle?, items}`. Each field
has `{label, type, value, format?}`; labels may repeat. Types are `text`,
`number`, `date`, `datetime` and `ref`, exactly as for table cells. Null is
always allowed; format belongs only to number fields. In scripts, an omitted
type becomes number for a finite number, datetime for a Date, ref for a Cloud
reference, or text for a string or null/undefined. Dates become wall-clock text
in the run's time zone; explicit date keeps that zone's calendar day. Saved
files require types. Labels, title and subtitle use the same bounds as stats.

Reference cells and details fields contain only `{type, id, title?}`, derived
from the platform resource reference contract: a namespaced capability type,
an ID of 1..512 characters, and an optional title of 1..500. Copy
`{...item.ref, title: item.title}` from a capability result; never build links.
The runtime strips every other key, including URLs, while saved references
with extra keys fail validation. Tables infer ref when every non-null cell,
footer included, is reference-like; explicit ref also works. Other objects
remain errors. Views never carry an href or URL for opening a reference.

The host displays `title ?? id` and opens the reference on click after a
confirmation, through the owning app's reader with the viewer's current access.
A view grants no access. Table sorting and Copy data use that visible text;
the CLI adds `(type:id)`. Stats and details print a Field/Value table in the
CLI, using the same locale formatting as the web host.

Explorers store one dataset as `{view: "explorer", title, subtitle?, columns,
rows, views, controls?}`. Columns and cells follow the table contract. Reference columns are allowed in
the table but cannot be encoded as x, y, series, value, filter or step.
`views` holds 1..6 strict chart mappings, each with a unique `id` (1..40
characters) and switcher `label` (1..80): bar (`x`, numeric `y`), line/scatter
(numeric or date/datetime `x`, numeric `y` or 1..8 unique y columns, optional
`series` with a single y), or heatmap (`x`, `y`, numeric `value`). All references
name existing column ids. `controls` is `{filter?, step?, compare?}`: filter and
series columns have at most 8 distinct values, step at most 480; all need
non-null cells in every row. Comparison needs a step and only line/scatter views.
Titles and subtitles use the table bounds; explorers allow at most 3,840 rows,
100 columns and 3,840 marks per view (rows × y columns), within the file limit.
Each view draws at most 480 bars per step (in total without a step) and 480
points per series per step.

Bars need one row per displayed x label per step, heatmaps one per displayed
x/y pair per step. Scripts aggregate to that grain before saving. Labels use
the table's localized cell text. Numeric axes and heatmap color bounds cover
the entire dataset, so filters and steps never rescale them; date x axes follow
the shown points. Validation checks axis precision without drawing, including
each date-axis step, and heatmap label fit over the union of steps. Strict
objects reject extra view, mapping or control keys.

Explorer filtering, stepping, pinned comparison, shared row selection and table
sorting happen locally and reset on reload. Hidden series retain their colors;
comparison lines are dashed and scatter points hollow. The table and **Copy
data** use the current state's rows, including the pinned step. The last
first-seen step opens initially, with every filter value visible. No saved
executable code or additional browser requests are needed for these interactions.

`present` returns a summary without values and renders an assistant-owned view
inline. A group summary lists each chart's kind and title to reserve its frame
while loading. Stats summaries include each label and booleans for sparkline,
sub and delta, so the host reserves the exact tile height without values.
Details summaries carry the field count and, for the first twelve fields, each
label, whether the value is a reference, and the length of its English display
text. The host sizes the record from a hidden copy of these fields with stand-in
text, so values that wrap on a phone keep their room; it shows at most twelve
one-line rows before the record scrolls. Explorer summaries list view ids,
labels and kinds, plus the `step`, `filter` and `compare` flags: step reserves
a slider row, filter or compare a controls row. Every reader validates the current
file; a file whose headings, stats parts or details sizes no longer match its
summary, including changed explorer mappings or control flags, and invalid or
missing files, show unavailable. Only assistant files below `/views/` ending in
`.view.json` qualify. HTML apps cannot save views; they draw with `cloud.chart()`.

The pure readers in `@k2b/cloud/ai/browser` are `parseCloudAiView`,
`checkCloudAiView`, `cloudAiViewSummary`, `cloudAiViewTable`, `cloudAiStatsTiles`,
`cloudAiDetailsRows`, `cloudAiTableTsv`,
`isAiViewFile`, `isAiViewPath`, `parseCloudAiChartToolView`,
`cloudAiExplorerControls` and `cloudAiExplorerState`. Parsing checks
schema and data without drawing; checking also verifies chart drawing for
writes; explorers check data and stepping without drawing on both write and read.
`cloudAiExplorerControls` returns localized filter and step choices in dataset
order and the initial request. `cloudAiExplorerState` projects chart inputs,
mark-to-dataset-row indexes and visible legends for a requested step, filter
keys and reference step. Table formatting uses the reader's locale; TSV quotes cells and guards
text against spreadsheet formulas. Table row keys are original row indices even
after sorting; hosts obtain a ref from `view.rows[Number(row.key)][column.id]`.
`cloudAiStatsTiles` returns formatted values and signed delta text, direction
and better/worse/neutral tone. `cloudAiDetailsRows` returns formatted text and
optional refs, with empty text for null. The view types, including
`CloudAiGroupView`, `CloudAiExplorerView`, `CloudAiExplorerRequest`, `CloudAiStatsView`, `CloudAiDetailsView` and `CloudAiViewReference`,
and these helpers are also exported from `@k2b/cloud/ai`, alongside
`createAiConversationView` and `AiViewInvalidError`. The writer checks conversation
ownership and archival, uses a title slug and deterministic run/index hash, and
preserves artifact retry and conflict semantics. Validation reports the issue;
field errors include paths; chart errors identify `charts[i]` in groups and
`views[i]` in explorers.
`CLOUD_AI_VIEW_DIRECTORY`, `CLOUD_AI_VIEW_SUFFIX`, `CLOUD_AI_VIEW_MAX_BYTES`,
`CLOUD_AI_TABLE_MAX_ROWS`, `CLOUD_AI_TABLE_MAX_COLUMNS`, `CLOUD_AI_VIEW_MAX_MARKS`,
`CLOUD_AI_GROUP_MAX_CHARTS` and `CLOUD_AI_STATS_MAX_ITEMS` export the bounds.

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
the user should receive the original file. For an HTML page, Cloud also stores
readable Markdown of the main content next to the raw file: title, headings,
paragraphs, lists, tables, and absolute links, without scripts, styles, or
navigation. The result returns this copy as `readable.path` and tells the model
to read it first. The raw HTML stays unchanged. The copy uses the same bounds
as other documents converted to Markdown: Cloud reads at most the first 20 MiB
of the page and keeps the copy within 1 MiB, ending a longer copy with a
truncation note. A page that needs more parser state than the conversion budget
is converted up to that point and ends with the truncation note. If the copy cannot be stored
(for example, because of the conversation quota), or the page has no readable
text, the result contains only the raw file. Both copies are untrusted data.
The tool does not clone or browse a repository, authenticate to a website, or
reach private network targets.
Download failures appear as a short category such as **File not found**,
**Authorization required**, or **File server error**, followed by an actionable
explanation; the activity disclosure retains the requested URL and full tool
response for diagnosis.

Clients that collect surveys or drafts can validate their results with
`CloudAiSurveyOutputSchema` and `CloudAiTextEditorOutputSchema` from
`@k2b/cloud/ai/browser` before submitting them.

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
  | `skill` | The name is an Assistant Skill this turn can load; `load_skill` loads it, not `load_tools` |
  | `not_offered_in_turn` | The tool exists, but this turn's client or task does not provide it, or the turn offers no app operations |
  | `not_allowed` | The conversation's fixed tool scope or task grants exclude it |
  | `app_offline` | The operation was loaded earlier, or the registry cannot be read, and its app is not in the live registry now |

  The model looks up an unknown name once with `search_tools`, loads a skill
  with `load_skill`, and does not search for or retry the other three in the
  same turn;
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
Cloud also describes each loaded capability's input in the schema subset every
model provider accepts: a tuple reaches the model as a bounded array of its
item schemas, an exclusive union (`oneOf`) as a plain union (`anyOf`), and the
app still validates the exact input.
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

Each question is one platform [approval request](/en/docs/identity/approvals)
with the arguments and the review the person saw. Directly before the Action
runs, AI Core reviews the call again and uses the approval once. When the
review changed in the meantime, the turn asks again with the current review
instead of running the Action. When a restart interrupted the Action after its
approval was used, the call ends with an error instead of running again.

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
Execution is different: after approval, AI Core resolves the review once more
and runs the Action only when it equals the snapshot; otherwise it asks again.

If no review is advertised, the approval shows the validated Action arguments.
If an advertised review fails, Cloud does not silently fall back to the weaker
display and does not execute the Action. The user may retry after the app or
resource becomes reviewable again.

A review does not alter arguments, grant permission, record consent, or replace
an app-owned safety workflow. For example, a domain fingerprint or optimistic
revision required by an Action remains part of the Action input and is enforced
again by the owning app.

### Approvals from an editor

[Assistant in editors](/en/docs/ai/editors) offers approval once or for the
current chat for requests that can be remembered. An editor may approve these
automatically. Actions that cannot be undone or reach other people, such as
sending mail, deleting, sharing, or inviting, wait for confirmation in Cloud;
the editor shows the link and can only reject them. Use `/approvals` in the
editor to revoke remembered choices.

## Handle approval in the UI

The Assistant's **Approvals** row above **Studio** opens a view of waiting
requests. **My account → Approvals** lists requests across apps.
A **Pending approvals** notification opens that list for requests from turns
started outside a signed-in browser session.
An ACP editor bridge can reject `confirm` requests but cannot approve them.
See [Action approvals](/en/docs/identity/approvals) for the lists, notification
rules, and decision channels.

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
request only reads, the card says that it reads data from the website and
offers **Allow this website for this chat**. A request only reads when it uses
GET or HEAD without a body, and every header it sends is one of the following,
with a plain value of at most 128 characters:

- `Accept`, `Accept-Language`, and `Range`, which name the response the code
  wants;
- `User-Agent`, which names the client;
- the cache validators `If-None-Match` and `If-Modified-Since`.

None of these headers carries a credential, overrides the method, or changes
where the request goes, and Cloud forwards no cookie or Cloud sign-in, so the
request stays an anonymous read of the same origin. The code chooses their
values just as it chooses the URL path and query, which the approval already
sends to that website. They reach no other website and add no credential. A
receipt shows only the method and URL, so the 128-character limit, the one the
Fetch standard sets for headers a browser sends without a CORS preflight, keeps
what the code can send beside the URL small.

Every other request asks every time, and its card keeps the warning that it may
change data or incur charges. That includes a secret reference, a header that
one of the person's secrets in this chat or app is bound to, `Authorization`,
an API key header, a method override, `Content-Type` or `Content-Language` (a
read has no body to describe), a longer value, and every other header. The HTTP
service never accepts `Cookie`, `Proxy-*`, or the other headers it controls, so
a request with one of them fails before it asks.

Cloud derives the website from the stored request on the server, never from
the model or the browser. Afterwards, requests in this chat are allowed without
asking only if all of these hold:

- the request has the exact same origin, so scheme, host, and port match;
- it is GET or HEAD without a body, with only the headers above and no secret
  reference;
- a person started the turn in a signed-in browser session, not a scheduled
  task, a mandate, `cld`, an API key, or another delegated credential;
- the code is the chat's own code or a Studio app the person manages, never an
  app they only use or HTML presented in the chat.

Website approvals are never offered as **Always**. `cld`, an API key, or
another delegated credential may approve the single request, but cannot
remember the website. Each request let through this way appears in the chat as
a receipt with its full URL, query included, from the moment it goes out, so a
run or read that fails afterwards keeps it. The receipt and the chat's
**Secrets & approvals** dialog both revoke it with one click. The
remembered-approval name is the reserved `website:read`, which no tool or
Capability can use.

A Studio app the person manages gets the same choice in its request dialog as
**Allow this website for this app**, under the same rules. An app that sends
`Accept` and `User-Agent` with every read therefore asks once, not on every
open or view. That approval lasts until it is revoked or the app is deleted.
Each request it lets through shows a notice with the full URL and a **Revoke**
action. The app's **Secrets & approvals** dialog lists these approvals.

The operator of an allowed website still sees every full address the code
requests, including the query, and the headers above, which may carry data from
the chat. Approve only websites you would let read what the chat contains.

A website approval covers its own origin, never a website it redirects to.
Code Mode does not follow redirects, and `fetch_file` stops at a redirect to
another origin, so the model must read that address directly, which asks.
`web_extract` reads through Firecrawl, which follows redirects on its side.
Its receipt names where the read ended, and content from another origin is not
returned, but the request has reached that origin by then. A website with an
open redirect can therefore pass an address it receives on to another website.

### Read web pages with provenance

`web_search` never asks. `web_extract` and `fetch_file` read an address
without asking only when the chat supplied it: the person wrote it in a
message, `web_search` returned it, or a page read earlier links to it. The
address must match one of these as a whole; a host and path that only appear
inside a longer address do not count. A message another chat sent counts as
none of these. Any other address, such as one the model built from other data
or found in a mail, shows an approval card with the full URL and the same
website choice as an HTTP request. A refused read fetches nothing. A scheduled
task cannot ask, so such a read fails there; its own prompt counts as the
person's message.

Links of a page read earlier count as supplied, so a page can offer the model
addresses to choose from. A page someone else controls can list links that
differ in one detail and tell the model to pick one according to data from the
chat; each such read then tells that website one choice. When a chat holds
data that must not leave it, read pages only from sources you trust.

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
