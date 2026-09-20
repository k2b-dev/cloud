# Assistant CLI

Use `cld assistant` for interactive access to the user's personal Cloud agent and for chat automation. Assistant is the CLI and GUI surface for personal conversations stored by Cloud AI Core; chats started from Mail or another application appear in the same history. The root command starts or continues a chat, while named management commands inspect chat state and files, resolve pending actions, manage personalization, and manage Projects.

## Interactive and print modes

Start a line-oriented terminal session:

```bash
cld assistant
cld assistant "Summarize my open work"
cld assistant --chat <chat-id>
```

The startup line shows the effective model. New chats print their stable resume command, and the CLI repeats it when the session ends. Blue `Info:` messages confirm non-error state changes. The interactive commands are deliberately small: `/help`, `/exit`, `/attach`, `/files`, and `/model`. Run `/model` without an argument to choose from the visible options by number. A selected model remains active for the session.

Enable local computer access explicitly:

```bash
cld assistant --allow-bash
```

This adds the predefined `local_bash` client tool only to turns from that
interactive session. The CLI prints the exact command and startup directory and
requires `Y/n` before every execution. It runs `/bin/bash` as the current OS
user with closed stdin, a fixed timeout, and bounded stdout/stderr. Tool calls
and results are stored in Cloud and remain visible in web chat history. The web
app cannot execute them. Do not use this mode for untrusted prompts without
reviewing each command carefully.

Use `--print` or `-p` to stream one response and exit:

```bash
cld assistant -p "Summarize my open work"
cld assistant -p --chat <chat-id> "What changed since then?"
printf '%s' "Summarize this carefully" | cld assistant -p
cld assistant -p --project <project-id> "Summarize the latest changes"
```

Assistant resource IDs are six-character, case-sensitive readable IDs such as
`kq4s54`. Use the IDs printed by the CLI directly; chat, turn, message, memory,
Project, knowledge, file, and reference commands do not accept database UUIDs.
Turn and message IDs are scoped to their chat. Access, knowledge, file, and
reference IDs are scoped to their Project.

Studio app and saved-script commands use the resource UUID returned by
`assistant code list` or `assistant code create`. These are separate from the
short chat and Project IDs above.

Useful options:

- `--title <title>` names a newly created chat.
- `--model <profile-id>` selects a model from `cld assistant models`.
- `--project <project-id>` creates the new chat in an accessible Project.
- Repeat `--attach <local-file>` for local images or documents. This flag does not accept a Cloud resource ID.
- `--detach` submits the turn and returns its ID without waiting in print mode.
- Repeat `--approve <exact-tool-name>` in print mode to approve only those tools for that turn. There is deliberately no approve-all flag.

Print mode writes assistant text and capability result tables to stdout and tool progress to stderr. Tables show up to 100 returned rows, shorten long cells for display, and include supplied result links. A notice identifies additional rows or pages. Use `--json` for complete returned cell values: it waits and prints one final aggregate without terminal tables. `--jsonl` emits versioned stream events such as text deltas, tool state changes, attention requests, and turn completion. Structured output, detached submission, and piped input require `--print`.
`--allow-bash` is deliberately rejected with `--print`, structured output, and
detached execution.

The web composer and CLI share one durable conversation draft. Before a CLI turn in an existing chat, the CLI refuses to replace a non-empty unsent web draft. Send or clear that draft in Assistant, then retry the CLI command. This prevents a terminal turn from silently overwriting text, files, or Cloud resources prepared in another tab.

If a turn needs an approval or frontend tool result that was not supplied, the command exits with status `2`. Inspect and resolve it explicitly:

```bash
cld assistant actions list <chat-id> <turn-id>
cld assistant actions approve <chat-id> <turn-id> <call-id>
cld assistant actions reject <chat-id> <turn-id> <call-id>
cld assistant actions submit <chat-id> <turn-id> <call-id> --result-file result.json
cld assistant turns watch <chat-id> <turn-id>
```

## Code Mode and Studio

Resource managers can use `assistant code database-status ID` without creating
a database, `database-export ID --out backup.sqlite` for a streamed backup,
and `database-reset ID --yes` to detach the current database and queue its
deletion. Reset preserves source, publications and shared files/KV. The next
connection creates a new empty database; retries cannot delete a replacement
created after the confirmed generation.

`assistant code storage-manage ID --input-file request.json` uses the existing
`area`, `operation`, `key`, `after`, `limit` storage contract with Manage access.
Use `assistant code storage-clear ID --area files|kv|all --yes` for bulk cleanup.
These commands share the Studio Advanced menu's permission-aware services.
Browser-local OPFS and KV belong to that browser profile. A CLI process cannot
purge them remotely; direct the user to Studio → Advanced → Local data.

Code Mode runs in an isolated browser worker hosted by the CLI. It does not need
an open Assistant browser tab. Install Playwright Chromium, or set
`CLOUD_CLI_CHROMIUM` to an existing Chromium executable.
Streaming reconnects after transport interruptions and periodically reconciles
the saved turn state. This keeps a missed completion event from leaving the CLI
waiting indefinitely; it does not restart completed tool calls.
Code has no Node/Bun environment, shell access, credentials, or unrestricted
network access. This is separate from `--allow-bash`.

```bash
cld assistant code list --json
cld assistant code list --search "sales totals" --json
cld assistant code create "CSV totals" --description "Sum uploaded sales rows"
cld assistant code write <resource-id> main.ts --content-file main.ts
cld assistant code get <resource-id> --json
cld assistant code run --chat <chat-id> --input-file run.json --json
cld assistant code actions <resource-id> --json
cld assistant code actions <resource-id> --draft --json
cld assistant code action --chat <chat-id> --input-file action.json --json
cld assistant code publish <resource-id>
cld assistant code versions <resource-id>
cld assistant code restore <resource-id> 1
cld assistant code fork <resource-id>
cld assistant code delete <resource-id> --yes
cld assistant code project-link <resource-id> <project-id>
cld assistant code access <resource-id>
cld assistant studio-admin list --json
```

All reusable programs are Apps (GUI, agent actions, or both), with optional
persistent data. One-off code belongs to its chat and cannot be shared.
`code actions` reads the published `app.actions.json` contract without running
code. `action.json` contains `{id,action,publishedVersion,input}`; copy the exact
name and version from discovery and follow its JSON input schema. Use access
suffices for published handlers. `--draft` discovery and `{id,action,revision,input}`
require Manage and test the exact current draft. Supply one version selector.
A changed version rejects execution; rediscover before retrying. Action errors,
including invalid output, do not undo effects. The `code action` command uses
the same isolated host, approval flags, and optional steps as `code run`.

`run.json` contains either `{"code":"export default () => 42"}` for a one-off,
or `{"id":"<resource-id>"}` for saved code. Add `inputPaths` for explicitly
selected files of the current chat. Scripts read those inputs on demand. In
explicit GUI test runs, the same paths supply isolated picker fixtures;
`files.list()` and `files.read()` remain unavailable to the app. User apps use
their own local picker and receive no implicit chat files. One-offs create no Studio resource. Optional
`--steps-file` accepts an array of `{name,args}` steps using `code_interact`,
`code_inspect`, or `code_export`; the CLI supplies the run ID. An export returns
an absolute chat-file path for `assistant files download` or a later run's
`inputPaths`. Snapshot output includes `outputTruncated`; export full results
instead of parsing a shortened preview. Pending input downloads pause startup
and readiness watchdogs, but still count toward the tool call's 45-second outer
budget. Capability approval waits pause that outer budget. At host capacity,
finished one-offs without UI, exports, pending requests, or running jobs are
reclaimed automatically. Invalid tool arguments return `kind: "input"` before
source execution.

For long work, use `work.run`, cooperative checkpoints, and progress.
`code_inspect` accepts `waitMs` up to 30000. After explicit steps, the CLI keeps
its host alive until active background work finishes. Closing the CLI interrupts
the worker. An unresolved modal requires an explicit interaction step.

Bundled `pdf.open` reads PDF pages/text/positions; `sheet.openExcel` reads XLSX
workbooks without running formulas. No package imports or Excel writer are
needed. Local folders have no 64-file/16-MiB aggregate cap: read one document
at a time and close it afterward. Parser budgets are 64 MiB per document and
128 MiB expanded XLSX XML. Selected chat inputs and captured exports retain
64 paths, 50 MiB per file, and 250 MiB total; use Blob for large exports.
Those are separate from persistent shared storage quotas.

Agent/CLI runs use isolated local test storage. Shared storage changes are real
and persist across runs and publications. Forks start with empty data. Use
`code storage` with JSON input for file list/delete and KV operations. Use
`code sql` with `{"sql":"SELECT title FROM todos LIMIT 20","params":[]}` for
a direct read-only query. It never creates a database. `code database-connect`
explicitly provisions one when the instance has rsql configured;
`code database` accepts structured schema/row operations. Project membership grants Use on linked published Apps, including
read/run/storage/database commands and copying published source. A Project chat
is not required; editing and management rights remain separate.

Normal capability approvals also apply inside scripts. Interactive Assistant
sessions show the review and eligible Remember option. For a direct run or
print-mode turn, repeat `--approve <exact-capability-name>` only for operations
the user authorized. There is no approve-all option.

Sharing and publication are separate. First publication uses `Initial release`;
subsequent `code publish` calls require `--note` or `--note-file`. Restore creates
a new publication and preserves user data. `code grant` and `code change-grant`
take the same permission payloads as the resource API. `studio-admin` provides
the corresponding administrator access/grant/change-grant commands and
`delete <resource-id> --yes` for confirmed deletion.

Read redacted connection state with `studio-admin settings`. Configure using
`studio-admin configure --input-file <private-json-file>` with `url` and `token`;
omit `token` to preserve it, or add `--test` to test without saving. Never put
the token directly in command arguments. Settings cannot replace a server that
still owns databases or pending cleanup. Central inventory covers shared data
and Project associations, not browser-local storage.

## Chats and turns

```bash
cld assistant chats list
cld assistant chats list --status needs_attention --json
cld assistant chats get <chat-id>
cld assistant messages list <chat-id>
cld assistant messages search <chat-id> "release date"
cld assistant resources list <chat-id>
cld assistant resources list <chat-id> --search nT1234
cld assistant resources search "release notes"
cld assistant chats timeline <chat-id>
cld assistant turns steer <chat-id> <turn-id> "Focus on the migration risk"
cld assistant turns stop <chat-id> <turn-id>
```

Chat management includes `chats create`, `update`, `pin`, `unpin`, `archive`, `restore`, `mark-read`, `compact`, `reindex`, and `index-status`. Message operations include `messages search`, `messages retry`, and `messages fork`. `resources list` inspects structured refs attached to or observed in one chat; `resources search` finds their occurrences across active owned chats. Resource results are based on schema-valid refs from conversation drafts, Project context, and capability calls, not IDs guessed from prose. A ref and its optional app link are presentation and identity, not authorization. Archiving requires `--yes`.

Assistant agents can discover previous conversations through the closed-world
`core.ai.chats.search`, `core.ai.chat.read`, and `core.ai.chat.search` Queries. They can inspect
structured refs through `core.ai.chat.resources` and `core.ai.chats.resources`. When the user
explicitly asks to send exact text to another owned chat, the agent may request
the reviewed `core.ai.chat.message` Action. The approval names the target and text;
delivery is durable, attributable to the source chat, same-user only, and
asynchronous when the target is busy.

## Scheduled chat tasks

Tasks belong to a chat, but each run uses an independent execution history.
It starts from completed chat context and reads current files, memories, and
Project resources. Interactive chatting can continue while it runs. Results and
failures are delivered to the original chat, reopening it and updating its
activity time. One-time `--at` values are local wall-clock times in `app.timezone`,
with the exact format `YYYY-MM-DDTHH:mm`. Recurring tasks use a five-field cron
expression in the same timezone.

```bash
cld assistant tasks list
cld assistant tasks status
cld assistant tasks list --chat <chat-id> --state active
cld assistant tasks get <task-id>
cld assistant tasks activities --limit 50
cld assistant tasks run-get <task-id> <occurrence-id>
cld assistant tasks create --chat <chat-id> --prompt "Check the release" --at 2026-08-12T09:30
cld assistant tasks create --chat <chat-id> --prompt-file ./weekly-review.md --cron "0 9 * * 1"
cld assistant tasks update <task-id> --at 2026-08-13T10:00
cld assistant tasks pause <task-id>
cld assistant tasks resume <task-id>
cld assistant tasks run <task-id>
cld assistant tasks delete <task-id> --yes
```

Capability grants are a JSON list. Each entry contains `appId`, `capabilityId`,
`kind` (`query` or `action`), and `fixedInput`. Fixed fields must match exactly;
`{}` allows any input within the caller's current access. Omitting grants when
creating a task gives it no capability grants. Updating grants replaces the list.
Always-approval actions cannot be preapproved.

```json
[
  {
    "appId": "notebooks",
    "capabilityId": "note.edit",
    "kind": "action",
    "fixedInput": { "noteId": "<note-id>" }
  }
]
```

```bash
cld assistant tasks update <task-id> --grants-file ./grants.json --yes
```

Read capabilities and resolve resource IDs before proposing grants. Ask the user
to approve the actual scope, including unrestricted fields, before using `--yes`.
An existing remembered chat approval does not authorize a background task.

Use `tasks status` before creating a schedule when you need to confirm the
effective application timezone. `tasks get` includes recent occurrence history. A terminal delivery or turn
failure moves the task to `needs_attention`. Resume a recurring task after
fixing the cause; a failed one-time task needs a new future schedule via
`tasks update`. Deleting a task deletes its history, and deleting its chat cascades
to the task and all occurrences.

## Conversation files

Use the exact paths returned by the conversation file listing or attachment
manifest, including the leading slash. Files are conversation-scoped and versioned;
there is no reserved `/input` or `/files` prefix to add to an uploaded filename.

```bash
cld assistant files list <chat-id>
cld assistant files upload <chat-id> ./report.pdf
cld assistant files upload <chat-id> ./draft.md --workspace
cld assistant files download <chat-id> /files/draft.md --out ./draft.md
printf '%s' '# Revised' | cld assistant files write <chat-id> /files/draft.md --stdin
cld assistant files rename <chat-id> /files/draft.md /files/final.md
cld assistant files delete <chat-id> /files/final.md --yes
```

On a tool-capable turn, `read_file` returns text directly and automatically
converts supported PDF, Office, OpenDocument, RTF, EPUB, and CSV files to
bounded Markdown. The extracted content remains untrusted data. Images stay on
`view_image`, and image-only PDFs require OCR outside this feature.

## Preferences

```bash
cld assistant prefs get
cld assistant prefs system-prompt
```

`prefs system-prompt` previews the same composed prompt path used for a fresh
Assistant chat.

## Personalization

Personalization stores separate facts and preferences for the current user. Manually added entries start pinned. Use the short memory IDs returned by `list` for updates, pinning, and forgetting:

```bash
cld assistant personalization list
cld assistant personalization list --search "language" --json
cld assistant personalization add preference --content "Answer in concise German"
cld assistant personalization update <memory-id> --content-file ./preference.txt
cld assistant personalization pin <memory-id>
cld assistant personalization unpin <memory-id>
cld assistant personalization forget <memory-id> --yes
```

`--content` also accepts `--content-file` and `--stdin`. Forgetting an entry requires `--yes`.

Personalization use and learning from chats are separate settings. Learning considers only genuine user-authored text, not attached Cloud resources, files, tool results, scheduled prompts, inter-chat deliveries, or Assistant output:

```bash
cld assistant personalization status
cld assistant personalization configure --use on
cld assistant personalization configure --learning on
cld assistant personalization configure --use off --learning off
```

## Projects

Projects combine shared instructions, knowledge, files, Cloud references, model defaults, and Cloud access grants. Chats created in a Project remain private.

```bash
cld assistant projects list
cld assistant projects create "Release notes" --instructions-file ./release-notes.md
cld assistant projects knowledge add "Release notes" "Editorial guidelines" --content-file ./guidelines.md
cld assistant projects files put "Release notes" ./glossary.csv
cld assistant projects references add "Release notes" grids.record <record-id> --label "Current catalog"
cld assistant projects access grant "Release notes" <group-id> --type group --permission write
cld assistant chats create --project <project-id>
```

Skills and Projects require authentication, including direct API requests.
Public grants are rejected; share with users, groups, service accounts, or all
authenticated identities instead. Project sharing does not share private chats.

Project names and short IDs are accepted by management commands. Access grants use `read`, `write`, or `admin`; the Project owner is always an administrator.

Run `cld assistant <group> help` or `cld assistant <group> <command> --help` for the complete accepted flags.

Resource deletion requires Manage access and removes publications, grants and
shared data; remote database cleanup is queued. It does not erase browser-local
data. Running resources without Manage access requires per-call capability
consent, including reads; personal remembered approvals do not apply.


### Shared Studio files and limits

Use binary commands for file contents (Use access; `--manage` explicitly requires
Manage). Project members inherit Use on linked published Apps:

```bash
cld assistant code file-upload APP --file invoice.pdf --key invoices/invoice.pdf
cld assistant code file-download APP --key invoices/invoice.pdf --out invoice.pdf
cld assistant studio-admin storage-settings --json
cld assistant studio-admin storage-configure --input-file limits.json
```

The administrator input is `{"fileMiB":50,"totalMiB":250}`. Those are also the
default byte budgets in MiB. There is no shared file count limit. File size can
be configured up to 64 MiB, total storage up to 1 TiB per resource. Shared KV
retains its separate 16 MiB/1,000-entry budget. Lists use `after`/`limit` pages.
An upload replaces the named key; use another key to keep both originals.
Lowering budgets preserves files and permits reads/deletes or non-growing
replacements. Storage settings do not raise chat or processing limits.
Direct JSON file read/write is no longer accepted; use the binary commands.


### PDF generation and Finance in Code Mode

Code run through the CLI uses the same Studio APIs: `pdf.render`, `pdf.attach`
and `pdf.facturX` return Blobs through the configured Gotenberg service.
`files.save` captures the result for an explicit export step. PDF calls use
binary multipart, preserve cancellation across the browser subprocess, and do
not need `--approve` for the internal conversion. App Use access or an accessible
unrestricted chat is required; source editing and resource maintenance retain
their existing Manage requirement.

`camt.parse` and `einvoice.validate/calculate/serialize/parseXml/parsePdf` are
available alongside `money`, `datev`, and `sepa`. No WASM/XSD checker is included.
CAMT supports camt.052.001.08; invoice generation supports EUR ZUGFeRD CII EN16931.
PDF invoice reading extracts embedded XML, not OCR. See the Code Mode Finance
and PDF references for full options and examples. Generating SEPA or invoice
files does not submit a payment or certify accounting compliance.

### Agent sharing and CLI parity

Assistant's `code_access_read` and `code_access_change` tools use the same App
permission service as Studio and the existing code-access CLI commands. Agent
changes require a freshly reviewed `accessRevision`; they cannot be pre-approved
with a model-supplied flag. App Use is `read`, Manage is `admin`. App recipients
are users, groups, authenticated users, or public. Public only accepts `read`;
public `admin` and service-account grants are rejected.

For Skills, discover `core.ai.skill.access.read` and
`core.ai.skill.access.change` through the CLI capability catalog and use the
normal capability review/execute flow. Read grants first and forward the exact
`accessRevision` as `expectedAccessRevision`. Resolve recipients through
`core.entities.search`. Skill and App grants remain independent.

`assistant code database-clear ID --yes` removes rows while retaining tables
and schema. It reads the current database generation and data revision before
execution. Inspect `completed` and `clearedTables`; a partial failure reports
`failedTable` and requires inspection before retrying. This differs from
`database-reset`, which discards schema too. Both preserve source and files/KV.

### Copy files between chats, Projects, and Apps

Use JSON files or stdin, preserving exact returned IDs and paths:

1. `assistant code files --input-file list.json`, with
   `{scope:"chat"|"project"|"app",id,after?,limit?}`. Follow `nextAfter`.
2. `assistant code file-stat --input-file stat.json`, with
   `{file:{scope,id,path}}`. Save the returned versioned `reference`.
3. `assistant code file-copy --input-file copy.json --yes`, with
   `{source:reference,destination:{scope,id,path},expectedVersion:null}` for a
   new path, or the current destination's opaque version for replacement.

Copies preserve binary bytes and apply both stores' permissions and destination
limits. App files require Use; Project destinations require Write; chats require
ownership. Project membership can provide Use for a linked published App.
Show the exact destination and overwrite before confirming; shared destinations
may disclose private chat files. Inspect conflicts or uncertain outcomes before
retrying. No vendor database API or filesystem access is implied by these tools.

Manage-only single-table deletion uses `code database <app-id> --input
'{"operation":"tables.delete","table":"obsolete"}'`. It removes the table
and its rows irreversibly; it is not available as a JavaScript database method.
Use an explicit user instruction for the named table. A full database reset is
not a substitute. Known file collisions return `CONFLICT`, byte rejections
`STORAGE_FULL`, and source validation failures `COMPILE_FAILED` with diagnostics.

### Standalone and public Studio apps

`cld assistant code url ID` returns the relative standalone `href`:
`/app/assistant/apps/ID/run`. Resolve it against the selected Cloud instance.
This URL runs the latest publication without the Assistant sidebar. Managers
keep the Studio management view as their default entry; Use-level users enter
the runner directly. Private links require sign-in and app access.

Publish with `cld assistant code publish ID`, then share explicitly if requested:

```bash
cld assistant code grant ID --input '{"principal":{"type":"public"},"permission":"read"}'
cld assistant code access ID
```

Remove the public entry using its returned access ID:

```bash
cld assistant code change-grant ID ACCESS_ID --input '{"permission":null}'
```

Public execution supports local computation, selected files, downloads and
browser-local storage. It never grants app database, server files/KV, secrets,
server HTTP/PDF or protected Cloud actions. Signed-in visitors need a separate
explicit app grant for these features. Warn before sharing an app that requires
them. Published code and embedded data become public, never its draft or history.
Unpublishing also prevents public loads. Already downloaded code cannot be recalled.
Operator `studio-admin grant` and `change-grant` enforce the same rules.

Cloud administrators can use this runner URL as a Link shortcut in the existing
navigation settings. Shortcut visibility and app access remain separate.

### Project Skills

```bash
cld assistant projects skills list PROJECT --json
cld assistant projects skills list PROJECT --available --search reconciliation --json
cld assistant projects skills link PROJECT SKILL_ID --yes
cld assistant projects skills unlink PROJECT SKILL_ID --yes
```

Lists are paginated with `--page`. Project members inherit Read/Use on linked
Skills, including the normal searchable catalog and lazy instruction loading.
Personal disabled-Skill preferences still apply. Linking and unlinking require
Manage on both resources. A link stays intact if its creator later loses access;
unlinking or losing membership removes only inherited access. Direct grants
remain. The same persistence rule applies to `code project-link` for Studio Apps.
