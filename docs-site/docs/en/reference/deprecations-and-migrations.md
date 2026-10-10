---
title: Deprecations and migrations
navTitle: Deprecations
section: Reference
order: 1250
description: Find removed or superseded APIs and the supported migration path.
tags: [deprecations, migrations, compatibility]
updated: 2026-10-10
---

# Deprecations and migrations

## Help requires sign-in

Cloud's Help surfaces are no longer public. Before, anyone could read every
application's Help without signing in, including Help of administrator-only
applications. Now `/api/help/v1/...` answers `401` without sign-in, and
`/help/apps/...` and `/app/<id>/help` lead to sign-in. OAuth clients of the Help
API need the `read` or `admin` scope, as for MCP. Signed-in users only see
Help of applications they may see: an application's `nav.requiresRoles`
limits its Help like the navigation, and an application reached only through
the admin area shows Help to administrators. The Assistant's `search_help` and
`read_help` and the MCP Help tools and resources apply the same rule; a service
account without a user sees no Help. Weather no longer shows its link or its
Help to guests; its pages already required a full account.

Nothing needs to be configured or migrated. Links to Help from outside Cloud
now ask for sign-in first. An application that renders Markdown from its own
Help declaration on a public page, as API Docs does with its getting-started
article, still shows that text there.

For application authors, `preloadLayoutHelp(c, appId)` returns `null` without a
signed-in user. If guests may not use your application, declare
`nav.requiresRoles: ["user"]` so guests see neither its link nor its Help.
`defineHelpCollection()` is deprecated: its router now requires sign-in but does
not apply the Help visibility rule, so only the mounting application's routes
guard it. Declare Help with `defineHelp()` and pass it to `app.start({ help })`
instead. See [Who can read Help](/en/docs/platform/help#who-can-read-help).

## Spaces removes the calendar timeline

The Spaces calendar no longer has a **Timeline** view. A saved link with
`cv=timeline` opens the month view of its day instead of failing. The row of
overdue tasks and the reader's undated tasks moves below the **Day** view.
The internal `GET /api/spaces/workspace/view` endpoint no longer reads `from`,
`to`, and `includeTray`, and a calendar snapshot no longer carries `range`;
only the timeline used them. A day view snapshot carries `tray`. No setting,
data, or migration is involved. See [Spaces](/en/apps/spaces).

## Applications can search their sent mail and read related apps' mail

This change is additive; existing calls behave as before. `mail.list` gains
the filters `q` (a case-insensitive substring of a recipient or the subject),
`recipient` (one exact address), `until`, and `apps`, and every `MailRecord`
now carries `appId`. Without `apps`, an application still reads only its own
mail. An application that declares the new platform permission `mail:read`
can read the mail of the applications an administrator chooses, through
`mail.readableApps()` and `filter.apps`, without their message text.
Applications that only declare `mail:read` can also call `mail.list`.

Operators decide in **Administration → Outgoing mail → Apps** or with
`cld admin outgoing-mail apps set-log-access`; nothing is shared until then.
On upgrade, Core adds a grant table and builds two search indexes on the send
log in the background, without delaying its start or new mail. Until they are
built, a search on a large log can stop after five seconds with `bad_input`. See
[Read other apps' mail](/en/docs/platform/outgoing-mail#read-other-apps-mail) and
[Let an app read other apps' mail](/en/docs/operations/outgoing-mail#let-an-app-read-other-apps-mail).

## Assistant notices when an offer fits

At the start of a followed turn, Cloud now checks the message and the latest
messages of the chat for three offer cases: a second format correction in a
row, a tone correction of a mail draft, and a reference to earlier work such
as "like last week". When one fits, the turn gets one short instruction to
offer a Skill or to remember the preference once at the end, so models that
skip the general Suggestions rules still make the offer. The tone case no
longer requires a Skill to have shaped the result. A question such as "What
can you do for me?" adds a bounded summary of the user's other chats and of
the Cloud items used in them; it holds only Assistant data, not which apps
have data for the user. Suggestion limits, organization instructions, and a
user's request for no suggestions still take precedence, and the instruction
repeats them. No setting changes; scheduled task runs are unaffected. See
[Turn recurring work into a Skill](/en/docs/ai/files-projects-and-personalization#turn-recurring-work-into-a-skill).

## Security fix: the gateway keeps requests on the application's host

This release contains a security fix in the gateway. Update promptly.

Before this release, a request whose path started with two slashes could make
the gateway forward it, with its cookies and other headers, to a host other
than the matched application. The gateway now always sends a request to the
host and port of the application's `baseUrl`, for HTTP and WebSocket, and
passes a leading run of slashes on as one slash. Other paths, including inner
double slashes and percent-encoded characters, reach the application
unchanged.

Whether an installation was exposed depends on what sits in front of the
gateway. `compose.prod.yml` runs behind the operator's external Traefik and
does not pin its version:

- **Traefik v2.11.24 or a later v2.11 release, or v3.3.6 or later,** with the
  default `sanitizePath: true` collapses duplicate slashes before the gateway
  sees the request. An installation behind it was not exposed this way.
- **An older Traefik, including v3.0 to v3.3.5, an entrypoint with
  `sanitizePath: false`, another reverse proxy that passes the path unchanged,
  or a gateway port that clients reach directly** forwarded such requests.
  Update, then check the reverse proxy's access logs for request paths that
  start with `//`. If such requests came from untrusted sources, treat the
  sessions of the users who sent them as exposed and revoke them; see
  [Emergency signing-key revocation](/en/docs/operations/identity-key-operations#emergency-signing-key-revocation)
  for invalidating every session at once.

The same release also hardens related path handling:

- Sign-in redirects and the configured home path no longer accept a target
  whose dot segments resolve to `//host`.
- Command paths and `returnTo` destinations, including the Mail composer's
  return address, no longer accept a path whose dot segments resolve to
  `//host`.
- Proxy authentication returns to the protected host's root when
  `X-Forwarded-Uri` would resolve to another host or does not parse, and
  ignores an `X-Forwarded-Host` value that is not a plain host.
- The Jobs **Run now** action in Gateway operations and the Grids last-visited
  base stay within Cloud for the same kind of path.

No configuration change is needed.

## A failing island shows a notice instead of freezing

Cloud now uses `@k2b/ssr` 0.15 and `@k2b/stdlib` 0.28. Each island mounts
inside its own error boundary, and `defineApp` gives it Cloud's localized
notice with **Try again**. See
[When an island fails](/en/docs/frontend/islands-and-hydration#when-an-island-fails).
Remove root `ErrorBoundary` wrappers that an island only had for protection.
Dialogs and floating windows from `@k2b/ui` get their own boundary and notice.
A dialog whose content throws while it opens no longer closes and rejects its
promise; it shows the notice and resolves `undefined` once closed.

Query and mutation state now describes only the load or the write. A component
that throws while it renders a query's or mutation's data no longer sets
`error()` or calls `onError`. `onSuccess` runs after `data()` and `loading()`
are updated, and `mutate()` and `retry()` reject with an error thrown by
`onSuccess`. Code that relied on `onError` for such errors moves that handling
to `try`/`catch` around `await mutate()`. See
[Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations#run-a-mutation).

A `Link` from `@k2b/ssr/nav` without `onNavigate` is now a plain link with a
full page load; `replace` and `scroll` apply only together with `onNavigate`.
The `@k2b/ui` navigation components already pass `onNavigate` when they enhance
navigation.

## AI provider behavior with Nessi 0.17

Review AI model output limits and budgets when upgrading:

- Anthropic defaults to 8,192 output tokens, including thinking, unless the
  profile or call sets an explicit limit. Budget reservations use that default.
- Gemini output usage includes thinking tokens, so reported reference costs
  and budget consumption can exceed visible-answer token counts.
- Failed and aborted turns retain already-reported usage. Each provider request
  is charged once, and its loop aggregate includes that usage for display.
- Provider-stopped answers, including refusals and content filters, end as
  failed turns. Their tool calls never run or resume, and the chat offers
  **Continue**.
- Structured tasks and compaction keep their previous reasoning requests; only
  OpenRouter now receives that `low` level in its `reasoning` object instead of
  a top-level `reasoning_effort`.
- An Ollama profile with `contextWindow` now sends it as `num_ctx`, so Ollama
  allocates that window instead of its memory-dependent default. Check that the
  server has memory for it, or clear the field.

See [Models and providers](/en/docs/ai/models-and-providers#set-the-thinking-level),
[Failed turns](/en/docs/ai/chat-runtime-and-streaming#failed-turns), and
[Usage and feedback](/en/docs/ai/usage-and-feedback#read-the-report).

## Applications send mail through outgoing mail

Application authors replace app-owned SMTP settings and transports with `mail`
from `@k2b/cloud/services` and declare `platformPermissions: ["mail:send"]`.
Operators can reuse the application's former SMTP account as a sender profile
and assign it to that application before removing its old deployment secret.
Follow the [application migration guide](/en/docs/platform/outgoing-mail#move-from-an-application-owned-smtp-account)
and [operator migration steps](/en/docs/operations/outgoing-mail#move-an-applications-smtp-account).

## Assistant keeps calculate loaded and offers after corrections

`calculate` is no longer a deferred built-in: a turn that offers it can call
it without `load_tools`, and only then does the platform prompt add a rule that
requires it for every amount, sum, or other number the model derives itself.
Numbers that a tool, file, or code result returns are stated as returned. A
fixed conversation tool scope that excludes `calculate`, or a model without
tool support, gets neither. The prompt also shows dates and times in the
runtime time zone, sends references to earlier work outside the current chat
to `core.ai.chats.search`, and lists the Skill and preference offer cases
under Suggestions instead of the Skill catalog.

The built-in `cloud-assistant` Skill template moves to version 3 with a
description that names such references, and `assistant-code-mode` moves to
version 62 with a description that points plain arithmetic to `calculate`. An
unmodified copy that is already linked to its template updates at the next
start; a customized one shows **Update available** under **Admin > AI >
Skills**. An older copy without a template link stays unchanged until an
administrator selects **Link to template**, as described in
[Update an installed built-in Skill](/en/docs/ai/files-projects-and-personalization#update-an-installed-built-in-skill).
No setting changes. See
[Turn recurring work into a Skill](/en/docs/ai/files-projects-and-personalization#turn-recurring-work-into-a-skill).

## Notebooks levels keep title order until arranged by hand

Writers can now arrange the notes of a level in Notebooks; the sidebar, Book,
export, and `cld notebooks ls` and `tree` follow that order. A level whose notes
all have `position` 0 reads by title, and arranging one note numbers the whole
level from 1. See [Notebooks](/en/apps/notebooks#use-notebooks).

The first start of this release sets every existing `position` to 0 once and
records that in `notebooks.data_migrations`. Earlier releases stored the
creation order there, which only the notebook export used; exports of existing
notebooks now list notes by title until someone arranges a level. Export
compares titles in one fixed English collation, so every export of a notebook
lists it in the same order, whoever downloads it. Templates no longer store
their note order.

In the Notebooks API (`/api/notebooks/{id}/notes`, `PATCH …/notes/{noteId}`,
`POST …/notes/{noteId}/move`) and the `note.create` and `note.move`
capabilities, `position` is now the 0-based place among the siblings and
renumbers that level; a value past the end appends. A move that only changes
`parentId` no longer needs `position`: the note joins the end of an arranged
level or the title order. `move` and `note.move` also accept `before` or
`after`, and `move` accepts `position: "first" | "last"`; `note.move` keeps its
integer `position`. `POST /api/notebooks/{id}/note-order/reset`
with `{ "parentId": … }` sets a level back to title order. `cld notebooks mv`
no longer sends the old position with every move.

While replicas of the previous release still run, notes they create take the
old creation-order position. That arranges an alphabetical level in creation
order, and in a level arranged by hand such a note can share its number with
another note, so the two read by title. Sort the level alphabetically from the
folder menu, or move any of its notes up or down, which numbers the level again.

Notebooks CLI plugins and browser tabs from before the upgrade still send a
note's old position with every move, so moving a note to another folder puts it
at that place, usually first, and arranges that folder by hand. Update the
plugin with `cld plugins update notebooks` and reload open Notebooks tabs; sort
an affected folder alphabetically from its menu.

## Assistant may end a reply with one offer

The platform prompt now tells the model what the chat keeps visible and allows
one concrete offer at the end of a reply, such as drafting an answer or saving
recurring work as a Skill. It replaces the earlier rule against repeated offers.
Scheduled task runs do not get these sections. Organization instructions that
ask for no suggestions, or for a different closing, take precedence; review
existing organization instructions that mention offers or follow-up questions.
The model also keeps intermediate files below the chat folder `/temp/`. See
[Files, Projects, Skills, and personalization](/en/docs/ai/files-projects-and-personalization#what-the-model-knows-about-the-chat).

## Failed Assistant turns say why and how to go on

A failed Assistant turn now stays visible in the chat with a notice that says
why it failed and what comes next, and offers **Continue** when a new turn can
finish the work. The server records the reason as a stable code in
`meta.turnError` on the turn's last message; see
[Failed turns](/en/docs/ai/chat-runtime-and-streaming#failed-turns).

`AiTurn.error`, `AiConversation.runError`, and the `error` of `turn_finished`
no longer carry the provider's own message or other internal text, but the
worded reason, for example "The model service did not answer. The results so
far are kept. Send a new message to continue." Code that matched those texts
reads `meta.turnError.code` instead. Operators find the raw cause in the error
log entry `AI turn failed` under `ai:executor`. A failed turn no longer streams
a temporary "⚠️" text block. The chat controller's `error()` no longer repeats
a failure the turn's notice shows. `AiConversation.runTurnId` names the latest
turn, which `runStatus` and `runError` describe.

Applications that host the chat timeline add
`AiChatActions.onContinueTurn(message)` and send `message` through their
normal send path to offer **Continue**; without it, the notice shows the
reason only. See [Failed turns](/en/docs/ai/chat-interface#failed-turns).

Turns that failed before the upgrade keep "Worked 4 min · interrupted" and
show no notice. A chat whose earlier turn left a call without a result, such
as a stop while an approval waited, no longer fails its next turn at providers
that reject such a history. No setting changes. Core and Assistant can update
in either order; Assistant shows **Continue** once both run this release.

## Studio apps are plain HTML

This breaking Assistant change replaces the `ui` tree with HTML apps. An app's
interface is now `index.html`, optional `style.css` and `app.js`, and further
JavaScript modules, running in a locked frame with the same `cloud` library as
scripts. See [Assistant](/en/apps/assistant#build-apps-as-html). Existing app
source is not migrated: an app without `index.html` has no interface until it is
rebuilt, for example with **Edit**, and its published actions keep working.

| Previous | Replacement |
| --- | --- |
| `ui.*` controls, layouts, Chart Explorer, `ui.modal.*` | HTML elements styled by the base stylesheet; `<dialog>` for questions; `cloud.chart` for charts |
| `ui.filePicker` | `<input type="file">` |
| A GUI entry that default-exports a function | `index.html`; `code_create` starts with one |
| `code_interact` | removed; the name is ignored in `clientToolIds`; scripts are tested with `code_run`, HTML apps with `code_check` |
| `code_inspect` with `nodeId`, `offset`, `limit` | `code_inspect({runId, waitMs?})` |
| `code_present({runId, title})` | `code_present({title, files})` for a one-off app, `code_present({id})` for a saved app |
| `code_run({id})` on an app with a GUI | `code_open` or `code_present`; `code_run` refuses an `index.html` entry |
| Runner route `GET /api/assistant/runner/:id/compiled` | `GET /api/assistant/runner/:id/app` returns published files and the viewer context |
| Public links to apps | switched off for now; see [Assistant](/en/apps/assistant#standalone-apps-and-public-links) |

Chat presentations saved as UI-tree snapshots cannot be shown anymore. The
Assistant startup migration clears them once and stores new presentations as
app files or a reference to a saved app; the `chat_presentation_inputs` table is
removed. Operators deploy the app frame prelude and base stylesheet with the
Assistant image; see [Build and deploy](/en/docs/operations/build-and-deploy).
`cloud.chart` returns the `@k2b/ui` chart markup (`.k2b-chart` with
`.k2b-chart__svg`) instead of `.cloud-chart`, and `cloud.pdf.render` styles PDFs
with the same base stylesheet as apps.

## Assistant offers Skills for recurring work

In chats a person follows, Assistant now recognizes recurring work and may
offer once to save the approach as a personal Skill; the Skill draft keeps
procedure and format and leaves out chat content, names, amounts, and resource
IDs other than a Studio App the Skill calls. The offer appears only while
`skill-creator` is enabled for the user. The built-in `skill-creator` template
moves to version 3. An unmodified installation updates at the next start. A
customized copy keeps its content and shows **Update available** under
**Admin > AI > Skills** until an administrator resets it. No setting changes.
Scheduled task runs are unaffected. See
[Turn recurring work into a Skill](/en/docs/ai/files-projects-and-personalization#turn-recurring-work-into-a-skill).

## Assistant offers code tools in every turn and says why a tool is missing

Every Assistant turn with the default tool source now offers the server-run code
tools `code_run`, `code_action`, `code_inspect`, `code_stop`, `code_export`,
and `code_present`. Before, only turns whose client listed them
in `clientToolIds` had them, so `cld assistant --detach`, API clients, and
scheduled tasks could not run code. Scheduled tasks now run them with their
task grants, as [Scheduled Code Mode](/en/docs/ai/chat-runtime-and-streaming#scheduled-code-mode)
describes. Only `code_open`, `code_secret`, and `local_bash` still need a client
that declares them. Clients that list the server-run names keep working; the
names have no effect.

The `load_tools` result changed. `loaded` and `alreadyLoaded` hold
`{name, call}` objects instead of names, and `missing` is replaced by
`unavailable`, a list of `{name, reason}` with the reasons `unknown`,
`not_offered_in_turn`, `not_allowed`, and `app_offline`. Code that reads
`load_tools` tool blocks from the conversation API reads the new fields; the
chat still shows results stored in the old shape. `load_tools` also accepts the
provider name of an app operation, and a call to a loaded app operation by its
capability ID now runs instead of failing as an unknown tool. See
[Tools and approvals](/en/docs/ai/tools-and-approvals).

No setting changes.

## Studio script and action library

This breaking Assistant runtime change replaces top-level helpers with one
frozen `cloud` global. Existing app source is not automatically migrated.
Update scripts and actions before deploying the new runtime. Operators should
ship the eager worker, content-hashed lazy chunks, and chunk manifest together.
Assistant’s normal startup migration adds personal KV storage; existing database
tables gain nullable audit columns on first access, without backfill.

| Previous API | Replacement |
| --- | --- |
| ai.generateText / classify / classifyMany / extractData | cloud.ai.text / classify (multiple) / extract |
| money | cloud.money; format/parse default to viewer locale |
| datev / sepa / camt / einvoice | cloud.finance.*; await every method |
| ids.ulid() | crypto.randomUUID() |
| http.fetch / secret | cloud.http.fetch / cloud.http.secret; every request requires approval |
| capabilities.run / streams | cloud.capabilities.run / streams |
| database.connect().table(name) | flat cloud.db.list/get/insert/update/delete; schema uses code_database tools |
| kv.shared | cloud.kv |
| kv.local | removed; use server-side cloud.kv.user for personal JSON |
| files.shared | cloud.files |
| files.local / store / opfs | removed; no personal file store or browser-local runtime storage |
| files.list/read for run inputs | script context files with path/size/type/file() |
| files.open/openMultiple/openFolder/path | removed; HTML apps use `<input type="file">` |
| files.save(data,name) | cloud.download(name,data) |
| sheet.fromCsv / openExcel / openOds | cloud.sheet.parseCsv / read (detected from bytes) |
| sheet.toCsv | await cloud.sheet.toCsv before downloading |
| pdf.open / facturX | cloud.pdf.read / render({facturX}) |
| work.* | script context signal/progress |
| ui.* | removed; see [Studio apps are plain HTML](#studio-apps-are-plain-html) |

Lists return at most 1,000 rows and raise `limit` when paging is needed. The
server sets created_by/updated_by and enforces each table’s everyone/own/managers
write rule. Personal KV is isolated per app and viewer across devices; anonymous
public-share visitors cannot use it or write database rows. Cloud calls fail with
CloudError and one of the documented stable codes. Secret-bearing HTTP responses
redact raw, prefixed, base64/base64url, JSON-escaped (including escaped slashes and ASCII Unicode escapes), and URL-encoded secret forms before reaching code.

## Assistant turns end loops and long runs with an answer

A chat turn, including scheduled and background ones, now stops using tools
and answers in three cases where it used to go on until it failed:

- In the last tenth of the run time limit (`ai.turn_timeout_minutes`, default
  30), so with the default after 27 minutes. A turn that used to fail with
  "Run time limit reached" now usually completes with what it has done and
  what is still open.
- When the same tool call fails twice with the same input, or after six tool
  searches in a row without a completed step, the model first gets a hint;
  when either pattern appears again, the turn answers without tools. A
  steering message gives the turn its tools back.

No setting changes. Operators who want turns to keep their full run time for
tools raise `ai.turn_timeout_minutes`. See
[Loops within a turn](/en/docs/ai/chat-runtime-and-streaming#loops-within-a-turn).

## Code tool failures are tool errors, and App action inputs are objects

Assistant's server-run code tools now report a call that does not complete as a
tool error, and the chat shows that step as failed. The code host returns such a
call as `CodeToolFailure` (`{failed: true, error, guidance?}`, exported from
`@k2b/cloud/ai/browser`). The earlier `{error}` results and the `kind: "input"`,
`kind: "host"`, and `retryable` fields are gone. A run whose code fails still
returns its snapshot with `status: "error"`. `cld assistant code run` and
`cld assistant code action` fail as before when a started call does not
complete; the error they report is now the `CodeToolFailure` object.

`code_action` takes its `input` as a JSON object and defaults to `{}`. JSON
text, numbers, arrays, and `null` are rejected, and a value that does not match
the action's schema returns `ACTION_INPUT_INVALID` naming each rejected field.
Publication rejects an action whose `inputSchema` does not have
`"type": "object"`; saved revisions keep compiling.

Studio Apps published earlier can still list an action with a scalar or array
`inputSchema`. That action can no longer be called: its author must change the
schema to an object, read the value from that object in the handler, and
publish again. To list the current publications whose action input is not an
object schema, run:

```sql
SELECT artifact.short_id, artifact.published_title, action->>'name' AS action
FROM assistant.artifacts artifact
JOIN assistant.artifact_revisions revision
  ON revision.artifact_id = artifact.id AND revision.revision = artifact.published_revision
CROSS JOIN LATERAL jsonb_array_elements(revision.source->'files') AS file
CROSS JOIN LATERAL jsonb_array_elements((file->>'content')::jsonb->'actions') AS action
WHERE file->>'path' = 'app.actions.json'
  AND action->'inputSchema'->>'type' IS DISTINCT FROM 'object';
```

An action without a `type` in its input schema stays callable with an object,
but its App cannot be published again until the schema says `"type": "object"`.

Update Core and Assistant together. While their versions differ, and when a
turn resumes a call that an earlier release completed, a failed call can still
reach the agent as a successful result, as in earlier releases.

## Assistant turns fold finished work into one line

The chat shows each Assistant turn in four places: one work line, the delivered
results, the newest text, and receipts for actions and decisions. See
[Chat interface](/en/docs/ai/chat-interface#four-places-per-turn).

`AiChatActions.renderCodePresentation` now receives an accessor instead of a
value. Cloud calls it once per `code_present` call, as soon as the call starts,
so the host can reserve its frame and keep a running session when the turn
ends. Replace `renderCodePresentation: (result) => <View result={result} />`
with `renderCodePresentation: (result) => <View result={result()} />`, and
treat `undefined` as "still running".

The server records two facts it did not record before:

- A turn that ends without a loop end of its own, such as a stop while an
  approval waits or a turn the sweep finalizes, stores `aborted` after a stop,
  or `error` when it failed or its wait expired, as the loop end of its last
  assistant message. Turns that ended this way before the upgrade show as
  finished.
- The stored result of a call the user approved carries the decision, so the
  approval stays visible as a receipt; a call that never returned keeps the
  decision on the message that holds it. Approvals decided before the upgrade
  show as ordinary steps, except Cloud actions, which always get a receipt.
- The time a secret prompt in Studio waits for its answer now counts as
  waiting instead of work, as approvals and survey answers do.

The live turn snapshot carries `actionWaitMs` and `waitingSince`, so a client
that reconnects shows the same work time. Both fields are optional: Core and
Assistant can update in either order, and open Assistant tabs show the new view
after a reload.

## Conversation streams announce provider retries

The conversation stream now sends a `provider_retry` event while a model call
waits to be retried after a transient provider failure; see
[Transient provider failures](/en/docs/ai/chat-runtime-and-streaming#transient-provider-failures).
Only `turn_finished` ends a turn. A client must ignore event types it does not
know, as the chat controller of earlier `@k2b/cloud` releases already does.

The `assistant` CLI plugin of earlier releases reads any event it does not know
as the end of the turn. At the first retry, `cld assistant` and
`cld assistant turns watch` stop following the turn and exit with status 0,
while the turn keeps running on the server; `--json` and `--jsonl` report a
finished turn without status and with empty text. A profile keeps its plugin
version until you update it, and `cld update` replaces only the `cld` binary.
Update the plugin of each profile:

```sh
cld plugins update assistant   # the current profile
cld plugins update --all       # every profile
```

## Assistant learns from private chats by default

Learning personalization from private chats is now on for everyone who has not
chosen. Earlier releases kept it off until a person turned it on. A person's
own choice always wins: Cloud stores a choice only when they save the **Learn
personalization from private chats** switch in **Assistant settings >
Personalization** or run `cld assistant personalization configure --learning`,
and they can turn learning off at any time. Saving **Use personalization** alone
no longer records a learning choice. Learning needs AI and a usable background
model, reads only private chats, and stays within the monthly budget described
in
[Personalization](/en/docs/ai/files-projects-and-personalization#use-personalization-for-durable-user-context).

Learning now considers only private-chat turns that finish while it is on.
When Core first starts this release, it marks every earlier turn and workflow
receipt of people who had not turned learning on as already considered, so the
new default never processes chats from before the upgrade. Later, chats that
finish while a person has learning off are never learned from either, also not
after they turn it on.

Earlier releases stored "off" for every person who ran an Assistant turn, so a
stored "off" can be an explicit choice or just the old default. Cloud cannot
tell them apart and keeps all of them off. Only people without a stored choice,
in practice those who have not used Assistant yet, follow the new default. To
see how many people keep an "off" from an earlier release, run:

```sql
SELECT count(*) FROM ai.user_prefs WHERE memory_learning_enabled = FALSE AND memory_learning_chosen_at IS NULL;
```

### Switch earlier "off" values to the default

Learning is private-data processing, so tell people before it starts, for
example in your release announcement: it is on unless they turn it off, it
saves facts, preferences, and repeated workflows only from their own private
chats that finish from now on, and they can review or delete every entry under
**Saved personalization**. If you then decide that the "off" values from
earlier releases should follow the new default, run:

```sql
UPDATE ai.user_prefs SET memory_learning_enabled = NULL
WHERE memory_learning_enabled = FALSE
  AND memory_learning_chosen_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM ai.memory_learning_runs run WHERE run.user_id = ai.user_prefs.user_id);
```

The statement never changes a choice saved since the upgrade, so you can run
it at any time. It also leaves out people for whom learning has already run at
least once: they had learning on, so their "off" is certainly their own choice.
Run history proves nothing about anyone else. An "off" from an earlier release
can still be deliberate, for example when someone turned learning on and off
again before it ever ran, and the statement switches those people on as well.
Learning then starts with chats that finish after the statement; their earlier
chats stay unprocessed.

There is no installation-wide setting for the default; learning stops only
while AI is disabled or no background model is available.

### Upgrade and roll back

Update Core and Assistant together and keep the mixed state short. A Core
replica of an earlier release shows learning as off for people without a
stored choice, although updated replicas already learn for them, and the chats
it finishes for people with learning off are not marked, so those chats can
still be learned from if learning is turned on for them later. An Assistant of
an earlier release saves both personalization switches together, so saving
**Use personalization** there also stores the learning switch as a choice.

Earlier releases treat a missing choice as off, but their settings dialog
sends the missing choice back, so saving only **Use personalization** fails for
those people. Before you roll back, store the earlier default for them and restore the
earlier column definition:

```sql
UPDATE ai.user_prefs SET memory_learning_enabled = FALSE WHERE memory_learning_enabled IS NULL;
ALTER TABLE ai.user_prefs
  ALTER COLUMN memory_learning_enabled SET DEFAULT FALSE,
  ALTER COLUMN memory_learning_enabled SET NOT NULL;
```

After a later upgrade, these people count as an "off" from an earlier release
again, and so does every "off" saved while the earlier release ran. Chats that
the earlier release finished can be learned from once learning is on for their
owner.

## Resources keep at least one manager

Grids Bases, Pulse Bases, and Venues now refuse a grant change that would
leave them without a manager. They answer `409` with code `LAST_MANAGER`;
Venue used to answer a removal of its last admin with `400`. Grids also refuses
a **None** grant for the same person, group, or account as the last manager.
The administration routes follow the same rule; an administrator recovers a
resource by granting a new manager first. Pulse and Venue now also check under
the same lock that the person who makes the change still manages the resource.

Contact books, Spaces, mailboxes, notebooks, Assistant projects and skills, and
Studio artifacts keep their own older checks for now. They also refuse to
remove the last admin, but they count every `admin` entry, including API keys
bound to the resource, and answer with their own status and message, not
`LAST_MANAGER`.

`PermissionEditor` locks the row of the only manager in every application,
including third-party applications on this release. Add the server check with
`ensureManagerRemains()` as described in
[Keep at least one manager](/en/docs/identity/authorization#keep-at-least-one-manager).
The editor counts only the entries it shows. If your editor hides every
service-account entry, as the API-key guide used to recommend, hide only the
resource-bound ones; otherwise a person who manages next to an agent is locked.
The access settings of contact books, Spaces, notebooks, and Venues now show
every grant except the resource's own API keys, which stay in the API key list.

Grids access lists now name people by their display name and show their photo.
The `displayName` of a person's entry in the Grids API and CLI is their
display name instead of their login name; match principals by ID, not by name.

## Info blocks follow one grammar

Markdown info blocks (`:::note`, `:::info`, `:::success`, `:::warning`, and
`:::danger`) follow one grammar in `MarkdownView`, the shared
`markdown.render()` helpers, Help, Notebooks, and PDF exports. Stored content
that relied on the older rules of one renderer can look different:

| Before | Now |
| --- | --- |
| The shared renderer drew a block inside a list item | Blocks work at the top level only; inside a list, a quote, or another block the text stays as written |
| A line that starts with `:::`, such as `:::trailing`, closed a block in the shared renderer | Only a line that holds just `:::` closes a block |
| The shared renderer read only bold, emphasis, and inline code in the body | The body is ordinary Markdown, including lists, links, and code |
| A block right after a paragraph line stayed paragraph text in the shared renderer | It starts a block, as in Notebooks |
| Notebooks showed `:::warning Before deleting` and `:::Warning` as plain text | Both render: the title is the visible heading, and the type takes any letter case |

Move a block out of a list, or end it with a bare `:::` line, to keep it
rendering. See [Markdown content](/en/ui/content/markdown#info-blocks) for the
exact rules.

## Applications can offer files to other applications

Capability manifests can now declare an optional `fileProvider`; see
[File providers](/en/docs/platform/file-providers). A manifest without it keeps
its earlier shape and hash, so nothing changes for applications that do not
offer files.

Files declares itself as a provider, and apps add files from it through the
shared file chooser, starting with attachments in Mail. Update Core before
Files: a Core of cloud-v0.29.0 or earlier drops Files from its catalog once
Files declares `fileProvider`. Catalog readers of cloud-v0.29.0 or earlier
fail on the whole catalog page that carries the Files entry until they are
updated once: third-party applications on an earlier `@k2b/cloud`, whose global
search and `listCapabilityCatalog()` read the catalog, and a `capabilities`
plugin of a `cld` profile that was not updated
(`cld plugins update capabilities`). Built-in applications of the same release
are already tolerant.

Before one of your own applications declares `fileProvider`, update Core,
your other applications on `@k2b/cloud`, and the `capabilities` plugin of each
`cld` profile to this release, as described in
[Capability readers ignore fields from newer releases](#capability-readers-ignore-fields-from-newer-releases).
Readers of earlier releases cannot read a manifest that carries `fileProvider`:
Core drops the application, and the other readers fail on the whole catalog
page. See [Roll out a provider](/en/docs/platform/file-providers#roll-out-a-provider).

## Capability readers ignore fields from newer releases

Capability manifests and catalog pages are now read tolerantly: a reader
ignores top-level fields that a newer Cloud release added and leaves out only
the entries it cannot read completely. Readers of earlier releases fail on a
whole catalog page, or skip the application, as soon as its manifest carries
one new field. See
[Read manifests from other Cloud releases](/en/docs/platform/capabilities#read-manifests-from-other-cloud-releases).

- Update `@k2b/cloud` once in your own applications. Their global search
  reads the catalog for Commands, as do `listCapabilityCatalog()`,
  `getCapabilityCatalogApp()`, and `CapabilityCatalogSchema`. Later manifest
  fields then no longer break them.
- Update the `capabilities` CLI plugin of each `cld` profile with
  `cld plugins update capabilities`.
- `app.start()` now rejects a capability declaration field its release does
  not define, at every level, instead of ignoring it: in the declaration, a
  Type, Query, Action, or Command, Universal Search, a search tag, or a stream.
  Remove such a field or update `@k2b/cloud` to the release that defines it.
- `CapabilityManifestSchema` is now a Zod pipe instead of an object schema. It
  no longer has `.shape`, `.extend()`, `.pick()`, or `.strict()`, and
  `z.input<typeof CapabilityManifestSchema>` is `unknown`. Parse with it and
  use the `CapabilityManifest` type for the result.

## Files references survive rename and move

On roots where Filegate 7 reports stable file IDs (`index: true` and
`managed: true`), Files now hands out `filesv2.entry` refs of the form
`n:<baseId>:<fileId>`. Spaces links, Grids resource fields, Assistant App data,
copied references, and `cld filesv2` file IDs created from now on keep naming
the same file or folder after a rename or move. Roots without stable IDs,
typically FreeIPA storage that users also write over NFS or SSH, keep path
refs. Nothing needs to be migrated:

- Refs stored earlier keep their path meaning and keep resolving. Files does
  not rewrite them, so the same file can have an older path ref and a newer
  stable ref.
- Check **Stable file IDs** for each root in `/admin/filesv2`. If it is off
  where you expect it, check that the root has `index: true` and
  `managed: true` and that Filegate is 7.0 or later.
- A backup restore onto new inodes or another device, or turning `managed`
  off, makes the stable refs of that root `not_found`. Back up as described in
  [Files supports Filegate 7](#files-supports-filegate-7).
- Update the Files CLI plugin of each profile with
  `cld plugins update filesv2`. An older plugin reads `n:…` as an area named
  `n` and rejects it.

If you roll Files back to an earlier release, nothing is rewritten. Refs
stored before this update keep working, and so do path refs handed out after
it. An earlier Files cannot read stable `n:…` refs: wherever one is stored, in
a Spaces link, a Grids resource field, Assistant App data, a copied reference,
or a `cld filesv2` file ID, it answers `not_found` until Files runs this
release or a later one again.

See [Refer to files and folders](/en/apps/filesv2#refer-to-files-and-folders).

## Assistant live updates use the shared live layer

Core now serves AI live updates on the shared live layer, at the same path
`/api/ai/live`, with one channel, `user`. Database triggers on the AI tables
write them to the platform outbox in the transaction of each change; who
receives a Project change is still decided when it is written. The visible
conversation streams over SSE in the browser too, from
`/api/ai/conversations/:id/stream`, as in the CLI. A returning tab replays the
updates it missed instead of reloading every Assistant view. See
[AI live updates](/en/docs/ai/chat-runtime-and-streaming#ai-live-updates).

The previous AI live protocol, its table, and its dispatcher are removed.
Code that used these exports stops type-checking:

| Removed | Use instead |
| --- | --- |
| `aiLiveRoutes`, `AiLiveRoutes`, and `AiLiveRoutesConfig` from `@k2b/cloud/ai/live` | Nothing: Core mounts the AI live socket |
| `latestAiInvalidationCursor(userId)` from `@k2b/cloud/ai/live` | `aiLive.cursor()` from `@k2b/cloud/ai/live` |
| `AI_LIVE_WS_TYPE`, `AiLiveClientMessage`, `AiLiveClientMessageSchema`, `AiLiveServerMessage`, `AiLiveServerMessageSchema`, `AiLiveCursorSchema`, `AiLiveRevocationCode`, `AiLiveErrorCode`, `AiTurnErrorCode`, `AiStreamEventSchema`, `aiTurnEventMessage`, and `parseAiLiveServerMessage` from `@k2b/cloud/ai/live-events` and `@k2b/cloud/ai` | `liveConnection()` from `@k2b/cloud/browser/live` speaks the socket protocol; parse the data with `AiInvalidationSchema` |
| `createAiLiveConnection`, `AiLiveConnection`, and `CreateAiLiveConnectionOptions` from `@k2b/cloud/ai/solid` | `createAiChatController()` with its default SSE stream, plus `liveConnection("/api/ai/live").subscribe("user", {}, …)` |
| `createPgOutbox()` options `onDelivered` and `maxAttempts`, and its unordered mode without `orderBy` and `sequence`, from `@k2b/cloud/services/outbox` | `orderBy` and `sequence` are required; a published row is deleted, and a failing row is retried until it is published |

`AI_INVALIDATION_DOMAINS`, `AiInvalidationSchema`, `createAiChatController()`,
`AiConversationStreamTransport`, `parseAiSse()`, and the conversation SSE
route stay. The data of an AI live update is the `AiInvalidation` it was
before.

### Update Core first

1. Replace every Core replica with this release, and make sure no Core replica
   of an earlier release starts again afterwards. Core's migration replaces
   `ai.enqueue_live_for_user()`; an earlier Core that starts again restores
   its own version, and its updates then reach no current Assistant tab.
2. Then update Assistant and Gateway Ops.

Assistant tabs that are open during the update lose their live socket once
and show "Live access changed or expired." until they are reloaded. Turns keep
running on the server; a frontend tool or approval that waits for such a tab
waits until it is reloaded. A tab of the new Assistant that reaches an earlier
Core reloads once and then shows that live updates stopped.

Gateway health reports an error on Core while `ai.enqueue_live_for_user()`
does not write to `events.outbox`: "AI live updates are not published: an
older Core restored ai.enqueue_live_for_user". Stop every older Core replica,
then restart one current Core replica; its migration restores the function.
Gateway Ops of this release also reports this error while Core's migration
has not run yet.

Proxies in front of Cloud must not buffer `text/event-stream` responses,
because browsers now stream conversations over SSE.

### Roll back

Roll back Core, Assistant, and Gateway Ops together, as the whole release.
Gateway Ops of this release would report the function that the earlier Core
restores as the error above and ask you to stop that Core. The earlier Core
restores its table and function when it starts. AI live updates that this
release wrote but had not published yet stay in `events.outbox`; they are
hints only, and you can delete them:

```sql
DELETE FROM events.outbox WHERE kind = 'live' AND app_id = 'core';
```

### Removed in a later release

Nothing writes `ai.live_invalidation_outbox` or the topic
`cloud-ai-invalidations` anymore. Until a later release removes both, an
earlier Core that still runs during the update finds an empty table instead of
an error, and the topic keeps its 128 MiB reservation; see
[Deployment requirements](/en/docs/operations/deployment-requirements).

## Notices have one calm look

`NoticeCard` from `@k2b/ui` has one appearance: a light tint of its tone, no
icon, and neutral text. Markdown callouts render the same notice. Code that
used the removed API stops type-checking; update it as follows.

| Old | Current |
| --- | --- |
| `NoticeCard` without `tone`, shown as a warning | Set `tone="warning"` where a warning is meant; without `tone` a notice is now `neutral` |
| `NoticeCard` `icon` | Removed. Name the state in `title` instead |
| `NOTICE_CARD_ICONS` | Removed |
| `NOTICE_CARD_CLASSES.inner` and `.icon` | Removed. Put the title and body directly in the root |
| `markdown.render()` and `markdown.renderSync()` option `{ notices }` | Removed. Every callout renders the calm notice |

Markdown callouts no longer show an icon or an automatic English type label.
An explicit `:::warning Before deleting` title stays the visible heading. An
untitled callout names its type for screen readers only, so add a title where
the type matters. See [Notices](/en/ui/feedback/blocks) and
[Use callouts](/en/docs/platform/help#use-callouts).

## Grids writes live updates through the platform outbox

Grids writes its live updates through the platform outbox that Core's
migration creates, in the transaction that makes a change, so a committed
change can no longer miss open pages. Update Core before Grids: Grids does not
start until `events.outbox` exists. See
[Live updates](/en/docs/automation/live-updates).

Grids pages share one socket on `/api/grids/live` with three channels:
`records` follows the records of one table, `metadata` the structure and
access of one Base, and `runs` the runs of one workflow. The socket reads the
topic `cloud:live:grids` and checks, when it delivers an update, that the
reader may read the Base, by the same rules as the Grids API. A changed grant
and a deleted Base check the readers of the Base's tables, structure, and runs
at once. The socket accepts every credential the Grids API accepts, so pages
in the phone app receive live updates too. A returning tab receives what it
missed instead of checking the Base structure again; the check every 30
seconds is gone.

`grids.enqueue_record_event()` keeps its signature. Besides the record event
that feeds record-event workflows and the change feed (`/changes`), it now
writes the live update of the table, and of every Combined table that shows a
changed field. The change feed, record-event triggers, and their workflow queue
are unchanged. A run update is written right after the workflow runtime has
stored the transition; one above 32 KiB makes open run details read the run
again.

A workflow action in a published Grids app no longer holds its status request
open until the run changes. The page asks for the status again after half a
second, then less often, at most every two seconds, as it already did when
live updates were unavailable.

The first Grids start after the update replaces
`grids.enqueue_record_event()`. Replicas of the previous version that still
run during a rolling update then write the live updates of record changes as
well, and the new replicas publish them; structure and run updates of an old
replica reach only tabs connected to it. A replica of the previous version
that starts during the rollout puts the previous function back, so new tabs
miss record updates until a new replica starts again. For one release,
`/api/grids/ws` closes the socket of a tab opened before the update with
`reload_required`; the tab shows that live updates stopped and offers a
reload.

Nothing writes the previous topics `grids:records`, `grids:metadata`, and
`grids:workflow-runs` anymore. Their streams keep their reservations of 1 GiB,
128 MiB, and 512 MiB until the next release removes them together with
`/api/grids/ws`; see
[Deployment requirements](/en/docs/operations/deployment-requirements).

If you roll Grids back, its start restores the previous function and live
updates work as before. Updates the new version wrote but did not publish yet
wait in `events.outbox` until Grids is updated again.

## Mail writes live updates through the platform outbox

Mail writes its live updates through the platform outbox that Core's migration
creates, from the trigger on its activity log, so they are part of the
transaction that records a change. Update Core before Mail: Mail does not start
until `events.outbox` exists. See
[Live updates](/en/docs/automation/live-updates).

Mail pages follow a mailbox on `/api/mail/live` with the channel `mailbox`,
which reads the topic `cloud:live:mail` and checks the reader's access when it
delivers an update. The mailbox view, the composer, and the mailing list dialog
of a page share one socket instead of opening one each, and a returning tab
receives what it missed instead of loading the view again. The socket accepts
every credential the Mail API accepts, so pages in the phone app receive live
updates too.

The first Mail start after the update replaces `mail.enqueue_live_invalidation()`
and drops `mail.live_invalidation_outbox`. The function keeps its signature, so
replicas of the previous version that still run during a rolling update write
their changes to the platform outbox as well, and the new replicas publish them.
A tab connected to a previous replica receives no updates until that replica
stops; for one release, `/api/mail/ws` then closes its socket with
`login_required`. A mailbox view reloads once. A compose page opened on its own
before the update receives no live updates until it is reloaded; its draft
lease still protects the draft. Previous replicas log
`Outbox reconcile failed` until they stop, because their table is gone.

Nothing writes the previous topic, `mail:invalidations`, anymore. Its events
expire after 24 hours, but its stream keeps its 1 GiB reservation until the
next release removes it together with `/api/mail/ws`; see
[Deployment requirements](/en/docs/operations/deployment-requirements).

If you roll Mail back to the previous version, its pages receive no live
updates until Mail is updated again, because the database keeps the new
function. Reloading a page shows the current state. The updates written
meanwhile wait in `events.outbox` and are published by the next Mail start.

## Files supports Filegate 7

Files is tested with Filegate 7.0; Filegate 6.1 keeps working. Upgrading the
Filegate daemon needs no migration: the index format, the `/v1` API, and leases
stay the same, and the root volumes and `state_dir` stay in place.

Upgrade Cloud before or together with the daemon. Filegate 7 publishes file IDs
only on roots with stable IDs, and earlier Files releases compare the IDs they
recorded under Filegate 6.1. On roots with `index: true` and `managed: false`,
those releases cannot finish these operations if they were still open when
the daemon changed:

- moving files and folders into the trash and restoring them from it;
- archiving, restoring, and deleting directories.

Repeating a completed trash restore also fails. These releases report
`source_changed` or `operation_unresolved` indefinitely. The current release
compares IDs only when both sides have one and otherwise compares modification
time and size, so these operations complete on their next retry or trash
listing.

Filegate 7 reports stable file IDs (`stableIds`) only for roots with both
`index: true` and `managed: true`. Such a root needs Filegate as its only
writer and readable and writable `user.*` extended attributes on the real
mount. Files uses these IDs for stable file references; see
[Files references survive rename and move](#files-references-survive-rename-and-move).
An ID stays valid only while the file
keeps its device and inode, so back up each root with its `.filegate`
directory, ownership, ACLs, and extended attributes together with the complete
`state_dir`, with Filegate stopped. Restoring copies onto new inodes or another
device assigns new IDs. Follow Filegate's backup and recovery guide.

## Spaces writes live updates through the platform outbox

Spaces writes its live updates in the transaction that makes the change,
through the platform outbox that Core's migration creates, so a change can no
longer commit without reaching open pages. Update Core before Spaces: Spaces
does not start until `events.outbox` exists. See
[Live updates](/en/docs/automation/live-updates).

Spaces pages follow a Space on `/api/spaces/live` with the channel `space`,
which reads the topic `cloud:live:spaces` and checks the reader's access when
it delivers an update. For one release, `/api/spaces/ws` answers tabs that were
open during the upgrade with a request to load the page again; such a tab
reloads once. While replicas of both versions run, a change handled by an older
replica reaches a new tab only after its next reload, and a tab whose page and
socket come from replicas of different versions can reload and then show "Live
updates are unavailable right now" until the rollout finishes; reloading the
page after the rollout restores live updates. Nothing writes the
previous topic, `cloud:spaces:events:items`, anymore. Its events expire after
24 hours, but its stream keeps its 1 GiB reservation until the next release
removes it together with `/api/spaces/ws`; see
[Deployment requirements](/en/docs/operations/deployment-requirements).

## Mail folders choose where their mail appears

A Mail folder's sidebar switch became a display with three values:
`everywhere`, `folder_only`, and `hidden`. A conversation whose mail lies only
in `folder_only` or `hidden` folders leaves All mail, the work views except
Assigned to me and Send problems, their counts, the cross-mailbox overview, and
the agent tools that list them; search and saved views still find it. See
[Mail](/en/apps/mail#choose-where-a-folders-mail-appears).

Folders that were hidden from the sidebar keep their mail out of those views
from now on, including folders older versions hid on discovery because they
were not subscribed. Set such a folder to `everywhere` if its mail should appear
there again. Newly discovered folders now always start as `everywhere`, also
when the account does not subscribe to them, so new shared folders and an
unsubscribed INBOX keep their mail in the views.

Gmail's All Mail, Important, and Starred never decide where mail appears, so
hiding them changes nothing. Mail recognizes Important and Starred at its next
folder discovery, which runs for every connected mailbox within 15 minutes of
the first start. Until then a hidden Important or Starred folder keeps
conversations that lie only there and in All Mail out of the views.

The first Mail start after this update adds `mail.folders.display`, filled from
`mail.folders.show_in_sidebar` (a shown folder becomes `everywhere`, a hidden
one `hidden`), and `mail.folders.provider_collection`. `show_in_sidebar` stays
and Mail keeps it current, so replicas can be replaced one by one and an older
image runs on the database without SQL. An older image shows `folder_only`
folders like `everywhere` ones and keeps every conversation in the views; its
own sidebar changes reach the newer version only through `show_in_sidebar`, not
the display. A later release drops `show_in_sidebar`.

`showInSidebar: false` in the `create_folder` command and
`cld mail folder create --hide-in-sidebar` now create a `hidden` folder.

| Old | New |
| --- | --- |
| `PATCH .../folders/{folderId}` with `{"showInSidebar": false}` | `{"display": "hidden"}` (or `everywhere`, `folder_only`) |
| `showInSidebar` in folder lists | `display`, `effectiveDisplay`, `displayInheritedFromFolderId`, `displayNeutral` |
| `cld mail folder hide <folder-id>` | `cld mail folder display set hidden <folder-id>` |
| `cld mail folder show <folder-id>` | `cld mail folder display set everywhere <folder-id>` |

Agents set the display with the `folder.display.set` action; `folder.list`
returns it.

## Grids change-feed cursors need one rescan

`cld grids records changes` and its HTTP route used to resume after the start
time of a write transaction. A long write that started earlier but committed
later, such as an import, could be skipped. The feed now resumes after the
writing transaction and returns a change only once every earlier write has
ended. Cursors saved before the upgrade answer `409` once: perform a full
Record scan and continue with the new cursor, as for an expired cursor. See
[Grids](/en/apps/grids#automate-grids-from-the-terminal).

## Contacts writes live updates through the platform outbox

Contacts writes its live updates in the transaction that makes the change,
through the platform outbox that Core's migration creates. Update Core before
Contacts: Contacts does not start until `events.outbox` exists. See
[Live updates](/en/docs/automation/live-updates).

The Contacts socket reads the topic `cloud:live:contacts`. With one Contacts
replica, tabs that are open during the upgrade reload once. While replicas of
both versions run, a change handled by an older replica reaches a new tab only
after its next reload, and a tab whose page and socket come from replicas of
different versions can reload and then show "Live updates stopped" until the
rollout finishes; reloading the page after the rollout restores live updates.
Nothing writes the previous topic, `cloud:contacts:events:changes`, anymore.
Its events expire after 24 hours, but its stream keeps its 1 GiB reservation
until a later release removes it; see
[Deployment requirements](/en/docs/operations/deployment-requirements).

A moved contact now arrives as a deletion in its source book and a creation in
its target book, so a reader of one book does not learn the other. Another tab
that shows the moved contact closes its details instead of following it.

## Live updates are served by routes(); subscribe() is removed

`defineLive()` from `@k2b/cloud/events` returns `routes(channels)`, the
application's live socket, instead of the interim `subscribe()`. Declare a
channel for each kind of subscription, mount `routes(channels)` at
`/api/<application ID>/live`, and subscribe from the browser with
`liveConnection()` from `@k2b/cloud/browser/live`. Remove the socket that
read `subscribe()`. See [Live updates](/en/docs/automation/live-updates) and
[Realtime UI](/en/docs/frontend/realtime-ui).

Contacts moved to `/api/contacts/live` with the channels `book` and `all`. For
one release, `/api/contacts/ws` answers tabs that were open during the upgrade
with a request to load the page again; such a tab reloads once. The next
release removes it.

## The legacy Files app is removed

Files (legacy), the `files` application with the `cloud-app-files` image and
the `/app/files`, `/api/files`, and `/admin/files` routes, is no longer part of
Cloud. Releases no longer publish its image, and the supplied Compose files no
longer define an `app-files` service. [Files](/en/apps/filesv2) (`filesv2`)
replaces it.

There is no automatic migration. Files never read the legacy application's
settings or storage, and nothing moves on upgrade. An installation that still
runs `app-files` must move its users to Files before it upgrades:

1. Set up Files with Filegate 7.0 as described in
   [Deployment requirements](/en/docs/operations/deployment-requirements), and
   map the home and group directories the legacy app served to Files storage.
2. Verify that users see and can open their files in `/app/filesv2`.
3. Remove the `app-files` service from the deployment. Do not keep an older
   `cloud-app-files` image running next to the new release.

Links to `/app/files` and legacy file references in chats or notes no longer
resolve.

The legacy application owned no database schema; it read the shared identity
tables. Upgrading deletes nothing. These records remain until an administrator
removes them after verifying Files:

- the `files.*` settings, including the encrypted `files.filegate_token`: in
  `/admin/settings` on the **General** tab, review **Legacy settings** and
  choose **Clean up**. The cleanup removes every stored key that no running
  application registers, not only `files.*`, so first check that the list holds
  nothing you still need.
- the offline `files` registration: in `/admin/gateway/apps`, choose
  **Remove offline app** for Files (legacy).

Once Files serves every directory you still need, stop the Filegate v2 daemon
and remove its configuration and token. Keep its storage: the home and group
directories in its `ALLOWED_BASE_PATHS` are the directories that Files roots
now point at. Remove a directory or volume only when no Files root references
it, and only after a backup.

## Venue objects no longer carry a calendar token

Venue objects in API responses, such as `GET /api/venue/venues`, and the
`cld venue` output no longer include `icalToken`. The venue-wide token had no
route since calendar links became personal, but every reader of a venue
received it. A person's calendar link comes from `GET /api/venue/calendar/my`.
On startup, Venue drops the unused `venue.venues.ical_token` column, and an
older Venue image fails to start without it. To roll Venue back to an older
image, first restore the column; no backup restore is needed:

```sql
ALTER TABLE venue.venues ADD COLUMN IF NOT EXISTS ical_token TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex');
```

Every venue gets a new token that no route accepts, and the next upgrade drops
the column again. See [Venues](/en/apps/venue).

## Venue exception notes are public and link addresses are checked

The Venue public page and `GET /api/venue/public/{id}/status` list the closed
days and special openings of the next 30 days as `upcomingExceptions`, each
with its note. This includes notes written before the change, which visitors
did not see until now. After upgrading, admins should review the notes of
upcoming exceptions and rewrite any that were meant only for staff.

Links sections accept only `https:`, `http:`, `mailto:`, and `tel:` addresses
and paths on the same Cloud that start with a single `/`. Creating or updating
a section with any other address answers 400. A stored link with such an
address, for example `www.example.org`, no longer appears on the public page;
the workspace preview says how many links visitors miss, and the section
saves again once the address is fixed. No data migration is required. See
[Venues](/en/apps/venue).

## Service accounts gain standalone and agent kinds

`ServiceAccount.kind` is now `user_delegated`, `resource_bound`, `standalone`,
or `agent`. Application code that treated every userless service account as
resource-bound must check `kind === "resource_bound"` before reading `appId`,
`resourceType`, or `resourceId`; a standalone account authenticates like a
user with its own grants. OAuth clients may bind a standalone account for the
client-credentials grant, and its access tokens carry `service_account_kind:
"standalone"` or `"agent"`. No migration is required: the `auth.service_accounts`
check constraints widen in place, and existing delegated and resource-bound
accounts, keys, and clients are unchanged. Operators provision agents with
`cld admin agents` and revoke them by disabling the account. See
[Standalone service accounts and agents](/en/docs/identity/service-accounts).

## The cloud-cli skill comes from cld

`cld update` no longer downloads `cloud-cli-skill.tar.gz`; the core skill is
embedded in `cld`, and `cld` writes it together with the installed modules'
references to every target in `skills.targets`. `cld update --skills-dir <dir>`
now adds a target instead of choosing one for a single run, and
`--claude-symlink` adds `~/.claude/skills` as a target that receives a copy
instead of a symlink; an existing symlink there is replaced by the copy. The
installer's `--skills-dir`, `--no-skills`, and `--claude-symlink` keep their
meaning and register the targets through `cld skills add`. The release still
publishes `cloud-cli-skill.tar.gz` for `cld` versions before this change. See
[Application CLI modules](/en/docs/platform/cli-modules#write-the-skill-for-agents).

A config from `cld` 0.17 or earlier has no `skills` entry, because only the
first `cld login` asked for targets. Updating such an installation to 0.19
therefore wrote no skill, and `cld skills list` reports no target. `cld update`
and `cld skills sync` now ask once when the config has no `skills` entry;
`--yes` takes `~/.agents/skills`, and without a terminal they write nothing and
print the `cld skills add` command. To restore the skill, run
`cld skills add ~/.agents/skills` once, or `cld update --yes` once `cld` runs a
release with this change. A target list emptied with `cld skills remove` stays
empty.

## First-party CLI modules are served plugins

`cld` no longer bundles the application modules (`account`, `admin`, `apps`,
`capabilities`, `accounts`, `api-docs`, `assistant`, `contacts`, `faq`,
`filesv2`, `grids`, `ipa-hosts`, `mail`, `notebooks`, `oauth`, `pulse`,
`spaces`, `tools`, `venue`). Each Cloud serves them as plugins, and a profile
installs the versions of its Cloud: accept the offer after `cld login`, or run
`cld plugins install --all`. A Cloud released before its applications served
plugins offers none; upgrade the Cloud or keep the previous `cld` for it.
Scripts that ran `cld <module> …` on a fresh machine must install the module
first. `tools` needs a Cloud to install from as well. The `cloud-cli` skill
ships no application references any more; `cld <module> reference [file]`
prints them from the installed plugin. See
[Application CLI modules](/en/docs/platform/cli-modules#install-a-plugin).

## CLI plugin installation

`cld plugins install <name>` now installs the plugin that the current
profile's Cloud serves. An npm package needs the `npm:` prefix, for example
`cld plugins install npm:@example/inventory-cli@1.4.0`; a bare package name no
longer reaches the npm registry. Local paths and `.tgz` archives are unchanged.
`cld plugins list --json` returns one row per plugin with `profile`, `name`,
`app`, `installed`, `available`, `status`, and `source` instead of the package
plugin fields `id` and `package`. See
[Application CLI modules](/en/docs/platform/cli-modules#install-a-plugin).

## Grids CLI commands

The `cld grids` commands for bases, tables, and records use the shared `cld`
verbs. The old names are removed without aliases; scripts must switch to the
new names. Arguments, flags, and `--json` output are unchanged, and every base,
table, or record argument now also accepts an address such as
`<base>:<table>/<record id>`. See
[Grids](/en/apps/grids#automate-grids-from-the-terminal).

| Old command | New command |
| --- | --- |
| `list`, `bases list` | `bases ls` |
| `bases get`, `tables get`, `records get` | `bases show`, `tables show`, `records show` |
| `bases create`, `tables create`, `records create` | `bases add`, `tables add`, `records add` |
| `bases update`, `tables update`, `records update` | `bases set`, `tables set`, `records set` |
| `bases delete`, `tables delete`, `records delete` | `bases rm`, `tables rm`, `records rm` |
| `tables list`, `records list` | `tables ls`, `records ls` |

## Mail CLI commands

The everyday `cld mail` commands use the shared verbs and addresses. The old
names are removed without aliases; scripts must switch to the new names. A
mailbox is its ID or exact name, a folder is `<mailbox>:<path>` such as
`"Support:Projekte / 2025"`, and an ambiguous name or path fails with `409`
and lists its candidates. Triage commands take up to 50 conversation IDs as
arguments and act on the Inbox unless `--in <folder>` names another source
folder. Administration, provider, identity, automation, workflow, operator,
repair, and storage commands keep their names. See
[Mail](/en/apps/mail#automate-mail-from-the-terminal).

| Old command | New command |
| --- | --- |
| `list` | `ls` |
| `conversation list [--folder <id>]` | `ls <mailbox>[:<folder path>]` |
| `conversation get` | `show <conversation>` |
| `message get` | `cat <message>` |
| `conversation assign --conversation <id>... --to <user>` | `assign <conversation>... --to <user>` |
| `conversation archive --source <folder-id>` | `archive <conversation>... [--in <folder>]` |
| `conversation move <conversation> <folder-id> --source <folder-id>` | `mv <conversation>... --to <folder> [--in <folder>]` |
| `conversation trash --source <folder-id>` | `rm <conversation>... --yes [--in <folder>]` |
| `conversation read`, `unread` | `read`, `unread <conversation>...` |
| `conversation star`, `unstar` | `flag`, `unflag <conversation>...` |
| `conversation tag add --conversation <id> --tag <id>` | `tag add <conversation>... --tag <tag>` |
| none | `tag rm <conversation>... --tag <tag>` |
| `conversation junk`, `not-spam --source <folder-id>` | `conversation junk`, `not-spam <conversation>... [--in <folder>]` |
| `conversation keyword add <conversation> <keyword> --source <folder-id>` | `conversation keyword add <conversation>... --keyword <keyword> [--in <folder>]` |
| `comment list`, `add`, `edit`, `delete` | `comments list`, `add`, `update`, `delete` |
| `send --identity --to --subject --body [--attach]` | `draft create ...`, `draft attachment add ...`, then `send <draft>` |
| `search --folder <name>` | `search --folder <path>`; a path matching several folders fails instead of searching all of them |

`send` now sends an existing draft instead of composing one. The new
`reply <conversation>` and `forward <conversation> --to <address>` create reply
and forward drafts from the latest message; `draft create --intent` still
works.

The Mail API adds `GET /api/mail/resolve?mailbox=<ref>[&folder=<ref>]`, which
resolves a mailbox ID or name and a folder ID or path, and answers `404` or
`409` with the candidates. No stored data changes.

## Files CLI commands

`cld filesv2` was rebuilt around shell-like verbs and file addresses. The old
command names are removed without aliases; scripts must switch to the new
names. Files are addressed as `<area>:/path` or by file ID instead of a base ID
followed by a path, `--path`, or `--to`. The area is `me`, a group's exact name
or ID, or a full area ID from `ls`; an ambiguous name fails with status 409 and
lists every candidate. Administrator commands use `--storage` instead of
`--area` and address directories as `<storage>/<users|groups>/<name>` or
`<storage>/archive/<archive-id>`. See
[Files](/en/apps/filesv2#use-the-cli).

| Old command | New command |
| --- | --- |
| `bases list` | `ls` |
| `list <base> --path <path>` | `ls <area>:/<path>` |
| `stat <base> <path>` | `stat <file>` |
| `download <base> <path> --out <local>` | `get <file> [<local>]` |
| `archive <base> <path>... --out <local>` | `get <folder> [<local>]`, `zip <entry>... --out <local>` |
| `upload <base> <local> --to <path>` | `put <local> <file>` (`--parents` creates folders) |
| `mkdir <base> <path>` | `mkdir [-p] <folder>` |
| `rename <base> <path> <name>` | `mv <file> <new-file>` in the same folder |
| `move <base> <path>... --to <folder>` | `mv <entry>... <folder>/` |
| `copy <base> <path>... --to <folder> [--target-base <base>]` | `cp <entry>... <folder>` |
| `delete <base> <path>...` | `rm <entry>... --yes` |
| `search <base> <query> --path <path>` | `search <folder> <query>` |
| `trash list <base>`, `trash restore <base> <id>` | `trash list <area>`, `trash restore <area> <id>` |
| `versions list <base> <path>` | `versions list <file>` |
| `versions download <base> <path> <id> --out <local>` | `versions get <file> <id> <local>` |
| `versions restore <base> <path> <id>` | `versions restore <file> <id>` |
| `versions comment <base> <path> <id> <text>` | `versions update <file> <id> --comment <text>` |
| `shares create <base> <path>...` | `shares add <entry>...` |
| `shares revoke <id>` | `shares revoke <id> --yes` (unchanged name) |
| `favorites add\|remove <base> <path>` | `favorites add\|remove <entry>` |
| `documents create <base> <path>` | `documents create <file>` |
| `documents markdown <base> <path>` | `documents create <file> --kind markdown` |
| `edit-url <base> <path>` | `edit-url <file>` |
| `thumbnail <base> <path> --out <local>` | `thumbnail <file> <local>` |
| `templates get <id>` | `templates show <id>` |
| `templates use <id> <base> <path>` | `templates use <id> <file>` |
| `admin templates import <base> <path>` | `admin templates import <file>` |
| `admin … --area <cloud\|freeipa>` | `admin … --storage <cloud\|freeipa>` |
| `admin files list --area --kind --name\|--archive-id --path` | `admin files ls <directory>[:/<path>]` |
| `admin files download <path> … --out <local>` | `admin files get <directory>:/<path> <local>` |
| `admin files delete <path> …` | `admin files rm <directory>:/<path> --confirm-path … --yes` |
| `admin versions list\|delete <path> …` | `admin versions list\|delete <directory>:/<path> …` |
| `admin directories archive\|retire\|delete <name> --area --kind` | `admin directories archive\|retire\|delete <storage>/<kind>/<name>` |
| `admin shares revoke <id>` | `admin shares revoke <id> --yes` (unchanged name) |

`tree` and `cat` are new. `recent`, `favorites list`, `shares list`,
`templates list`, and the remaining administrator commands keep their names.
The Files API adds `GET /api/filesv2/entries/:id`, which resolves a file ID
with the same access checks as a path. No stored data changes.

## Contacts CLI commands

`cld contacts` now uses the shared command verbs and addresses contacts by
ID or `<book>:<name>`. The old command names are removed without aliases;
scripts must switch to the new names. The `--book` and `--contact` flags and
the local default book (`use`, `current`) are gone: pass the book in every
address. `show --email <address>` finds a contact by email. Contact JSON input
is `--from <file|->` instead of `--json-input` and `--stdin`; note text is
`--from <file|->` or `--content <text>` instead of `--file` and `--stdin`.
Destructive commands need `--yes` without a terminal. See
[Contacts](/en/apps/contacts#automate-contacts-from-the-terminal).

| Old command | New command |
| --- | --- |
| `books` | `ls` |
| `use`, `current` | removed; pass the book in every address |
| `book` | `show <book>:` |
| `create-book [--use]`, `update-book`, `delete-book` | `books add`, `books update`, `books delete` |
| `list` | `ls <book>` (`--q`, `--tag`) |
| `get` | `show <contact>`, `show --email <address>` |
| `create` | `add <book>[:<name>]` |
| `update` | `set <contact>` |
| `move --target-book` | `mv <contact> <book>` |
| `delete` | `rm <contact>` |
| `notes`, `note`, `update-note`, `delete-note` | `notes list`, `add`, `update`, `delete` |
| `tags`, `create-tag`, `update-tag`, `delete-tag` | `tags list <book>`, `tags add\|update\|delete <book>:<tag>` |
| `import-preview` | `import <book> --from <file\|-> --dry-run` |
| `--query` | `--q` |
| `--output` | `--out` |
| `--firstName`, `--per_page`, and other camelCase or snake_case aliases, `--parent-contact` | the kebab-case flag (`--first-name`, `--per-page`), `--parent` |

`import` without `--dry-run` now creates the previewed contacts, skipping
matches unless `--include-duplicates` is given. `search`, `tree`, `export`,
and the `access` group keep their names. The Contacts API adds
`GET /api/contacts/resolve`. No stored data changes.

## Notebooks CLI commands

`cld notebooks` was rebuilt around note addresses and a local Markdown mirror.
The old command names are removed without aliases; scripts must switch to the
new names. Notes are addressed as a note ID, `<notebook>:<path>`, or a file in
a pulled mirror instead of `--notebook` and `--note` flags, and the local
default notebook (`use`, `current`) is gone. Content input is `--from <file|->`
or `--content <text>` instead of `--file`, `--stdin`, and `--content`. See
[Notebooks](/en/apps/notebooks#automate-notebooks-from-the-terminal).

| Old command | New command |
| --- | --- |
| `list` | `ls` |
| `use`, `current` | removed; pass the notebook in every address |
| `get` | `stat <notebook>:` |
| `notes` | `ls <notebook>[:<path>]` |
| `note`, `content`, `read` | `stat <note>`, `cat <note>` (`--json`, `--numbered`, `--blocks`) |
| `block` | `cat <note> --block <name>` |
| `create-note` | `write <notebook>:<path> [--parents]` |
| `edit --set-content` | `write <note>` |
| `move-note` | `mv <note> <target>` |
| `copy-note` | `cp <note> <notebook>[:<path>]` |
| `delete-note` | `rm <note>` |
| `lock-note` | `lock <note>` |
| `search --all`, `tag-notes` | `search [query] [--notebook] [--tags]` |
| `favorite`, `unfavorite`, `favorites` | `favorites add`, `favorites remove`, `favorites list` |
| `comments`, `add-comment`, `update-comment`, `delete-comment` | `comments list`, `add`, `update`, `delete` |
| `versions`, `version`, `restore-version` | `versions list`, `versions cat`, `versions restore --into` |
| `upload-attachment` | `attach <note> <file>` |
| `attachments`, `download-attachment`, `delete-attachment` | `attachments list`, `download`, `delete` |
| `attachment`, `attachment-usage` | `attachments list --json`, usage shown by `attachments delete` |
| `create-from-template` | `create <name> --template <id>` |
| `api-keys`, `create-api-key`, `revoke-api-key` | `api-keys list`, `create`, `revoke` |
| `snapshot`, `update-snapshot`, `snapshot-logs`, `run-snapshot` | `snapshots show`, `set`, `logs`, `run` |
| `--output-file` | `--out` |

`cld notebooks create` now creates an empty notebook without the welcome note;
the web UI still seeds it. The Notebooks API adds `GET /api/notebooks/notes/:noteId`,
`GET /api/notebooks/:id/outline`, and `GET /api/notebooks/:id/resolve`, and
`POST /api/notebooks/:id/notes` accepts `parentPath` and `createParents`. No
stored data changes.

## Spaces CLI commands

`cld spaces` now uses the shared `cld` verbs and item addresses. The old
command names are removed without aliases; scripts must switch to the new
names. An item is addressed as an item ID or `<space>:<title>` instead of a
leading space argument or `--space`, and the local default space (`use`,
`current`) is gone. Text input is `--from <file|->` instead of `--file` and
`--stdin`; `--page-size` is `--per-page`. See
[Spaces](/en/apps/spaces#automate-spaces-from-the-terminal).

| Old command | New command |
| --- | --- |
| `list` | `ls` |
| `use`, `current` | removed; name the space in every address |
| `get [space]` | `show <space>:` |
| `create` | `create` (no `--use`) |
| `items [space]` | `ls <space>` |
| `items --assigned-to me`, `unassigned` | `ls <space> --mine`, `--unassigned` |
| `items --deadline`, `--activity inactive` | `ls <space> --due`, `--inactive`; new `--due-before` |
| `item [space] <item>` | `show <item>` |
| `add-item [space] <title> --column` | `add <space>:<title> [--column]` (defaults to the first column) |
| `update-item [space] <item>` | `set <item>` |
| `update-item --column` | `mv <item> <column>` |
| none | `rm <item> --yes`, `assign <item> <user\|me\|none>`, `due <item> <date\|none>` |
| `blockers`, `blocks` | `deps <item>` |
| `block <task> <blocker>` | `deps <task> --add <blocker>` |
| `unblock <task> <blocker>` | `deps <task> --rm <blocker>` |
| `comments` | `comments list` |
| `comment` | `comments add` (new `comments update`, `comments delete`) |
| `attachments` | `attachments list` |
| `add-attachment --file <path>` | `attachments add <item> <path>` |
| `download-attachment --output` | `attachments download <item> <attachment> --out` |
| `delete-attachment` | `attachments delete` |
| `checklist add --label <text>` | `checklist add <item> <text>` |
| `references remove` | `references delete` |
| `calendar --from --to` | `calendar <start> <end>` |
| `overlap --from --to --exclude-item` | `overlap <start> <end> --exclude <item>` |
| `activity`, `work`, `claim`, `release`, `progress`, `done`, `reopen`, `invitation context`, `invitation draft`, `access …` | unchanged names; the item is one address argument |
| `--file`, `--stdin` | `--from <file\|->` |
| `--page-size` | `--per-page` |

The Spaces API adds `GET /api/spaces/items/:itemId` and
`GET /api/spaces/resolve?space=&title=`; the item filter accepts
`deadlineBefore`, and assignable users include `uid`. No stored data changes.

## Workflow action costs

Move budget counts from `plan().consumes` into the action's `cost(ctx, config)`
hook. `plan()` now produces only dry-run summaries, issues and optional output;
it is never called during execution. Both modes use `cost()` for budget counts.
Update all action declarations together with the platform; there is no fallback
to `plan().consumes`. No stored workflow data migration is required.
See [effect budgets](/en/docs/automation/effects-retry-and-reconciliation#plan-and-charge-effects).

## Contextual Universal Search

Search Queries now accept an optional resource scope in the canonical input
schema and may declare local `scopeTypes`. Update all search-provider images
together with the platform; old manifests do not match the new shared schema.
No stored data changes are required. Use
[the shared browser search API](/en/docs/platform/search#open-search-from-an-application)
in place of app-local navigation Spotlight dialogs. Selection pickers remain
separate.

## Production configuration cleanup

Built-in images use production mode and port 3000. Remove runtime `APP_ID`
and `PORT` overrides; application identity comes from its declaration. Build
and development scripts still accept `APP_ID` to select an application.

FreeIPA no longer imports environment configuration. Configure the `freeipa.*`
settings, including group rules, in administration. Remove Cloud-side
`FREEIPA_*`, `GROUPS_*`, `FILEGATE_URL` and `FILEGATE_TOKEN` bootstrap inputs. Filegate's own server configuration remains separate.

Grids query limits moved to `grids.query_pool_size`, `grids.query_concurrency`,
`grids.query_queue_limit` and `grids.query_queue_timeout_ms` on its admin page.
Remove the corresponding `GRIDS_QUERY_*` environment variables. Restart all
Grids instances after saving these settings.

Mail's unreleased Google/Microsoft managed OAuth integration has been removed:
provider environment variables, `mail.oauth.*` settings, browser callbacks,
automatic token refresh and reconnect flows are no longer available. Users
create IMAP/SMTP connections with a password, app password or manually supplied
access token. Manual access tokens are not renewed automatically. No migration
of old alpha managed OAuth connections is provided; use a fresh Mail schema.
The Cloud OAuth application and its client integrations are unchanged.

Mail's alpha migration chain (versions 1 to 126) was collapsed into a single
baseline schema. Mail has never been deployed, so no upgrade path exists: a
development database that still holds the old versions is refused at startup and
is reset with `DROP SCHEMA mail CASCADE;`.

Pulse is included in production Compose and the release image set. Fresh Core
installations use an explicitly supplied temporary `ADMIN_LOGIN_TOKEN` for
first access; see [Deployment requirements](/en/docs/operations/deployment-requirements).

## Grids starts with a fresh schema

Grids creates its current schema at startup. There is no in-place migration
from older Grids schemas. Before switching an existing installation, the
operator must stop Grids and explicitly reset its schema and Grids-owned
shared workflow and access data. This discards the existing Grids content;
keep any required backups or exports separately. Delete only Grids-owned rows
in shared Core tables, never the shared schemas or another application's data.
Start Core before Grids. Subsequent Grids starts preserve the current data.

### Reset an existing Grids installation

This procedure permanently discards Grids content, workflow runs, generated
documents, and resource-bound credentials. It is not an upgrade that preserves
data. Confirm the target database and NATS namespace, obtain approval for this
scope, and keep a restorable backup before starting. A schema-only reset is
incomplete: old kernel runs would still appear in Grids health reports.

Stop every Grids replica and worker, and prevent new Grids invocations during
the maintenance window. Inventory foreign keys and cross-application references
before deleting anything. If another application references a Grids resource or
service account, stop and resolve that dependency; do not let `CASCADE` remove it.

Perform the database cleanup in one transaction, in this order:

1. Capture access IDs from `grids.base_access` and `grids.custom_app_access`,
   Grids resource-bound service accounts and their grants, and kernel workflow
   and event IDs where `app_id = 'grids'`. Retain this inventory until verified.
2. Check that captured grants and service accounts are not used by another
   application. Preserve shared grants and ordinary user accounts.
3. Delete `workflows.event_delivery` rows referencing the captured workflow
   **or** event IDs. Delete rows from `workflows.workflow`, `workflows.event`,
   and `workflows.dependency_signal` only where `app_id = 'grids'`. Their
   kernel child rows are removed through foreign keys.
4. Delete `capabilities.idempotency_claims` and `capabilities.executions` only
   where `app_id = 'grids'`, so old results cannot be replayed.
5. Run `DROP SCHEMA grids CASCADE` only after the dependency checks above.
6. Delete captured, exclusively Grids-owned `auth.access` rows. Remove mandates
   only where `owner_app_id = 'grids'`, then the captured resource-bound service
   accounts and their credentials. Do not delete delegated user accounts.
7. Commit. On an unexpected dependency or error, roll back and investigate.

PostgreSQL and NATS cleanup are separate operations. Keep Grids stopped until
both finish. Inventory streams by their Sync metadata, not a guessed name
prefix. Delete only streams with the verified `sync.namespace`,
`sync.owner=grids`, and these resource IDs, including their associated
key-value and dead-letter streams:

- `grids:workflow-record-events`
- `grids:evidence-export`
- `grids:controlled-destruction`
- `grids:workflows`
- `grids:external-record-operation-retention`
- `grids:records`
- `grids:metadata`
- `grids:workflow-runtime`
- `grids:workflow-runs`

Do not delete shared volumes, other namespaces, or other applications' streams.
If transport cleanup fails, leave Grids stopped and resume from the inventory;
do not start new workers against old queued work.

Start the updated Core before the updated Grids. Check gateway registration,
an authenticated Grids page, empty Base/Record/Document lists, and the health
view for leftover Grids runs. Confirm a second Grids start preserves the schema
and any newly created data. Old Grids links in other applications remain but
point to removed resources; do not delete their chats or audit history.

## Mail automation authority is mandate-only

Mail incoming automations no longer create, store or forward user API tokens.
Spaces actions require a mandate and Mail's app-bound `identity:invoke`
credential. The authority-mode flag and credential backfill have been removed.

Mail is unreleased alpha, so this change does not convert old automation data.
Use a fresh Mail schema when replacing an older alpha installation. Existing
test data and previously issued credentials are not deleted automatically;
resetting them is a separate operator action, not an application startup step.

## Notebook scripts are now inert Markdown

Notebooks no longer executes fenced `script` blocks. Existing source remains
in each note as visible code. Use `:::toc` for an in-note contents list and
`:::query` with named `:::data` properties for notebook summaries. Update
automation that sends `scriptsEnabled` or uses `--scripts-enabled`; the
setting and script-specific APIs are removed.

The shared `markdown.render()` and `markdown.renderSync()` helpers also render
`script` fences as ordinary code blocks. They no longer emit executable source
carriers or output containers. Application authors must remove any custom
enhancer that depended on those carriers; Markdown rendering does not execute
user code. Help examples remain inert.

## Identity authority rollout prerequisites

Deploy Core's purpose-specific session and invocation JWKS endpoints before
their consumers. Every Core replica behind the configured JWKS origin must
support them, including when Core is itself a consumer. Mixed old/new endpoint
pools can fail on cold caches. Drain every old replica before the coordinated
hard cut; no issuance-mode or old-writer fallback remains. See the
network, database, clock, and rollout requirements in
[Runtime configuration](/en/docs/operations/runtime-configuration).

The public gateway now rejects HTTP and WebSocket paths containing an
`_internal` segment. Broker callers must use the private Core origin. This is
an ingress boundary, not a substitute for workload authentication.

## Confirmed-only mandate coordinates require a coordinated cutover

The mandate uniqueness index now covers confirmed active or paused rows only.
This prevents pending registrations from reserving another workload's identity.
The previous targeted `ON CONFLICT` statement cannot run against that new
index and fails with PostgreSQL `42P10`. This schema change is not compatible
with old mandate-writing processes.

Before starting a Core version that migrates this index:

1. stop mandate-writing Core and application processes, including background
   workers and separately deployed applications using the old Cloud package;
2. update every writer to the version using `ON CONFLICT DO NOTHING`;
3. start updated Core to migrate, then start the updated application writers;
4. verify interactive creation, pending confirmation, and background delivery
   before restoring workload creation traffic.

Do not restart old mandate writers against the new schema. An operator needing
a rolling upgrade must first deploy a compatibility release that changes only
the insert conflict handling on every writer, then deploy the index migration.
This mandate-index change does not itself revoke credentials. The JWT-only
browser and OAuth hard cut below must be coordinated with it.

## Widget response validation and budgets

Widget responses remain extensible: unknown fields are stripped. Safe relative
links and absolute HTTP(S) links remain accepted, while active schemes and
oversized or malformed payloads are rejected. Dashboard runs eight requests at
a time with 500 ms per started widget and a page budget derived from the number
of waves. See [Dashboard widgets](/en/docs/platform/dashboard-widgets).

## JWT-only sessions and internal invocations

Use the [coordinated upgrade checklist](/en/docs/operations/deployment-requirements#coordinate-an-existing-installations-identity-upgrade)
for preparation, startup order, verification, and rollback. The contract below
defines what changes for sessions and OAuth clients.

This is a coordinated hard cut, not a rolling compatibility release. All
Cloud users must sign in again. Existing OAuth clients, refresh grants, API
credentials, and background mandates retain their separate lifecycles.

1. Back up PostgreSQL and the Core identity-key encryption key. Drain old Core
   and application replicas, including background workers, before migration.
2. Deploy Core and every application with the JWT-only release. Keep the
   Core-only key encryption key configured and both purpose-specific JWKS
   endpoints reachable. There is no browser or invocation issuance-mode switch.
3. Core's migration revokes existing JWT browser families once and removes the
   legacy generation column. Opaque Valkey sessions are always rejected.
   Repeated migrations preserve new logins and do not change user epochs.
4. Verify a new login, logout, WebSocket reconnect, search, widgets, and an
   existing OAuth client before restoring traffic and background work.

Do not roll an old binary back onto the migrated schema. Recovery requires a
coordinated compatible release or restoration of the backed-up database and
keys. Do not flush shared Valkey: unused opaque session keys expire naturally;
old generation keys are no longer read or written.

Application code must use request `actor` and `accessSubject`, not parse or
persist session tokens. `session.createDelegation`, `session.getData`,
`session.parseToken`, and the legacy forwarding middleware are removed.
Use `session.authenticate` for live session reauthorization and the public
capability/mandate APIs for cross-application work. Internal capability and
widget endpoints reject browser cookies, OAuth tokens, and API keys; Core
issues target- and operation-bound invocation JWTs for them.

### OAuth signing hard cut

OAuth no longer accepts `CLOUD_APP_CREDENTIAL` or the Compose input
`CLOUD_OAUTH_APP_CREDENTIAL`. Replace them with `CLOUD_OAUTH_BROKER_SECRET` on
Core and OAuth; see [Runtime configuration](/en/docs/operations/runtime-configuration).
Revoke any previously provisioned OAuth workload credential through the admin
identity API. The retired `identity:oauth-issue` scope is no longer provisionable
and remains blocked at ordinary API entry points. Client secrets are unrelated
and do not need replacement.

Include every OAuth replica in the maintenance window. Configure the same
`CLOUD_OAUTH_BROKER_SECRET` exclusively on Core and OAuth, start updated Core,
then start updated OAuth. Its migration drops only the obsolete `oauth.keys` and
`oauth.issuance_state` tables and the old code-audience compatibility trigger.
Client registrations, client secrets, authorization codes and refresh families
are retained. Existing code snapshots are backfilled where needed.

Old OAuth access and ID tokens are no longer supported by the updated Cloud.
Clients with a valid refresh grant can obtain Core-issued tokens; others need
another authorization. No supported OAuth grant type, PKCE, dynamic
registration, consent or resource-binding feature is removed. Clients using
discovery do not need a new client ID or secret. A client that manually pins
signing keys must load Core's keys from the unchanged public JWKS URL. An
external client's cached old keys are not remotely erased by this update.

The combined `/.well-known/cloud-identity-jwks.json` endpoint is removed.
Current applications use the separate session and invocation JWKS endpoints.
Do not restart old binaries against this schema. Restoring removed signing
material requires the pre-upgrade database backup; there is no signing-mode
rollback switch.

Scheduled AI/chat tasks without a stored mandate no longer acquire one during
background execution. Admission marks them `needs_attention`; the owner must
delete and recreate them. Existing mandated tasks are unaffected. This removes
the system-migration authority path, including the obsolete Mail variant.

## Conversation files use one namespace

The alpha `/input` versus `/files` path policy was removed. Uploads and
assistant-created artifacts now share the absolute conversation namespace, and
the durable `origin` field owns overwrite policy. Turn payloads reference every
attachment, including images; inline base64 image parts and the CLI
`--workspace` upload switch were removed without a compatibility shim.

Deprecated APIs remain for source compatibility.

Do not use them in new code. Migrate one boundary at a time and keep behavior
covered by tests.

## Server helpers

| Old | Current |
| --- | --- |
| `validator` | `v` |
| untyped `apiClient` | `api.create<TApi>()` |

`validator` is an alias. Replace the import and keep the existing schema.

The old `apiClient` is untyped. Export the final Hono router type, then create a
typed browser client with the real base URL.

See [Browser clients](/en/docs/frontend/browser-clients-and-mutations).

## Access inputs

`getEffectivePermission()` still accepts `userId`, `userGroups`, and
`serviceAccountId`.

Pass `subject` instead.

```ts
await getEffectivePermission({
  accessIds,
  subject: c.get("accessSubject"),
});
```

`userGroups` is ignored. Cloud resolves direct and nested membership from the
authoritative platform tables.

See [Authorization](/en/docs/identity/authorization).

## Encoded JSON metadata upgrade

For upgrades from the June 23, 2026 production baseline, the startup migrations
automatically repair encoded deleted-account, audit, and Venue objects. They discard
malformed Tools logs and Gateway registry snapshots, and cancel notification batches with
invalid selection containers. Valid data survives repeated startup. Stop old
writers before starting updated services; no manual repair command is required.
See [JSON metadata upgrade](/en/docs/operations/repair-jsonb-containers) for the
preservation rules and optional diagnosis. The NATS, identity, and OAuth release
prerequisites still apply independently.

## Notification email uses outgoing mail

Notification email and batches now appear in the outgoing-mail send log as app
`core`. Configure a default sender profile and keep Core's outgoing-mail runtime
running. Notification batches follow that profile's pace; set it to the
provider's limit. The old direct-SMTP notification path has been removed.

Temporary SMTP failures keep email pending while outgoing mail retries it.
Recommended fallback channels activate only after a terminal mail failure,
which can take up to the 24-hour delivery deadline. They stay deferred during
SMTP retries to avoid delivering through both channels if SMTP recovers.

The migration adds outgoing-mail IDs to deliveries, batch recipients, and legacy
message rows, plus send generations for legacy messages. Recovery updates legacy
history when accepted mail settles; resending in-flight mail reuses it.
Existing notification history remains intact. See
[Outgoing mail operations](/en/docs/operations/outgoing-mail).

## Notification delivery upgrade

When replacing the queue-based notification runtime, stop old application
instances before starting the new version. Preserve notification tables:
startup recovery resumes accepted pending deliveries and scheduled retries.
The job-based runtime does not consume old queues. Remove their transport
resources only after verifying delivery recovery.

## Notifications

The email-only `notifications.send(params)` overload and
`notifications.sendToUser()` are deprecated.

Declare a typed notification in `defineApp({ notifications })`, then send the
bound definition:

```ts
await notifications.send(app.notifications.stockLow, {
  recipient: { userId },
  data: { itemId, itemName, remaining },
  idempotencyKey: `stock-low:${itemId}:${thresholdVersion}`,
});
```

This adds runtime validation, recipient policy, channel selection, and delivery
history.

See [Notifications](/en/docs/platform/notifications).

## UI

| Old | Current |
| --- | --- |
| `DockWorkspace` | `Panes` with application-owned layout state |
| `DateTimeInput` | `DatePicker` or `DateTimePicker` |
| `SettingsModal.subtitle` | Section descriptions |
| `SettingsModal.icon` | Tab icons |

`DockWorkspace` remains only for legacy screens. Do not extend its persistence
format.

Use the [UI catalog](/ui) to inspect the current UI contract.

## Shared utilities

Import generic utilities directly from `@k2b/stdlib`.

`@k2b/cloud/shared` continues to re-export `dates`, `calendar`,
`encoding`, `fileIcons`, and `gradients` for older applications.

Cloud-specific shared helpers remain on the Cloud path.

## AI names

| Old | Current |
| --- | --- |
| `AiDataPolicy` | `AiDataBoundary` |
| `startAiRuntimeRecovery()` | `startAiRuntime()` |
| `aiConversationStore` | `aiConversations` |

The alpha AI service and runtime renames are hard cuts; there are no compatibility aliases.

## Remove compatibility code safely

1. search application source for the old symbol;
2. migrate and test each call site;
3. run the standalone package typecheck;
4. verify browser and server bundle boundaries;
5. remove local adapters that only supported the old shape.

The current package version does not assign removal dates to these APIs.

## Help moves to Postgres

Update Core and every Help-producing application to the same new Cloud release.
This is a coordinated breaking change; old processes still write the retired
NATS Help registry and cannot populate the new store.

1. Prepare the new application images and the existing Postgres connection.
2. Run Core setup to create the Help schema and start the updated Core readers.
3. Restart every application with the updated Cloud package. Each application
   publishes its packaged Markdown before advertising readiness.
4. Verify an article, a search, and an AI or MCP Help read in the intended language.

No export or import of the old NATS Help registry is required. Keep app-owned
Markdown and `app.start({ help })`. The dedicated Help ephemeral and its
`helpRegistry`, `getHelp`, `listHelp`, and `HELP_REGISTRY_CONFIG` exports are
removed, along with the old registry corpus types and `resolveHelpManifest`.
Apps should use the automatic Help surfaces instead of those platform internals.
Runtime app metadata now contains a Help reference rather than article lists.
The article endpoint returns `HELP_NOT_FOUND` (404) for an absent article or
published version; the old `HELP_STALE` response is retired. Search returns no
matches for an absent app or version. Database failures still return errors.

Core owns the SQL schema. If it is missing, rerun Core setup before restarting
applications. Existing app heartbeats restore missing collections once the
schema is available. See [In-product Help](/en/docs/platform/help) for search,
limits, and lifecycle behavior.

Do not upgrade a Postgres volume merely to enable optional BM25. Native search
works without that extension. Rolling back requires a consistent old image set
and application restarts to repopulate its NATS registry; retained SQL rows do
not make old readers compatible. Retired NATS resource removal is a separate
operator action after verifying the cutover.

## Workspace mobile navigation

The `AppWorkspace.SidebarMobileTrigger`, `SidebarMobile`, `SidebarMobileItems`,
and `SidebarMobileBody` slots and their prop types have been removed. There is
no compatibility renderer. Use `createNavigation` and let the host render
`Navigation`; Cloud applications bind it through `WorkspaceNavigationProvider`
or the SSR `WorkspaceNavigation` island. Keep `SidebarDesktop` for desktop.
See [Application shells](/en/docs/frontend/application-shells#supply-mobile-navigation).

## Capability protocol 2

Capability manifests now include a required `commands` array. Providers declare
`protocolVersion: 2`; compilation emits an empty array when no Commands are
published. Protocol 1 manifests are rejected, with no compatibility adapter.
Upgrade the shared package and every provider together. The existing
`/capabilities/v1` HTTP routes remain unchanged; the manifest protocol is a
separate contract. No database migration is required.

Mail's interactive task/event creation now opens the owning Spaces form through
a Command. The old Mail `POST .../conversations/:conversationId/spaces/items`
and `GET .../spaces/:spaceId` form-support routes are removed. Existing resource
link/unlink operations and calendar automation continue to use their domain APIs.

## Application keyboard shortcuts

Register browser context commands with an optional `shortcut` instead of
application `hotkeys.create()` calls or window key listeners. Remove the old
registration when moving each action; retaining both executes it twice.
Shortcut-only event relays should call the existing command or search API.
See [Context command shortcuts](/en/docs/platform/search#context-command-shortcuts).

The portable UI package no longer exports `isSpotlightShortcut` or
`SPOTLIGHT_SHORTCUT*` constants. `SpotlightButton` has no implicit shortcut
label. Supply `shortcutLabel` only when the host actually owns that binding.

## Outgoing mail sender profiles

The `mail.noreply.*` setting definitions and `/api/admin/core/settings/test-email`
route are replaced by outgoing mail profiles and the per-profile test route.
Core imports configured legacy SMTP settings automatically.
See [Outgoing mail operations](/en/docs/operations/outgoing-mail) for the upgrade
and rollback rules.
