# Assistant CLI

Use `cld assistant` for interactive access to the user's personal Cloud agent and for chat automation. Assistant is the CLI and GUI surface for personal conversations stored by Cloud AI Core; chats started from Mail or another application appear in the same history. The root command starts or continues a chat, while named management commands inspect chat state and files, resolve pending actions, manage personalization, and manage Projects.

`cld ai` is a short form of `cld assistant` for people typing in a terminal; agents keep using `cld assistant`.

Before you configure the Assistant for someone, read
[How the Assistant works](how-it-works.md) (`cld assistant reference how-it-works.md`).
It explains whose permissions the Assistant uses, what Projects share and
whether it is live, which Actions need approval, how routines are
authorized, and when to use instructions, Skills, memories, or knowledge.
The CLI and API call routines tasks: `cld assistant tasks`, `core.ai.task.*`.

## Move Skills between Cloud and folders

```bash
cld assistant skills list [--search <text>]
cld assistant skills push <dir> [--force]
cld assistant skills pull <name-or-id> [dir] [--force]
```

Push creates or updates the Cloud Skill with the folder's exact name, even when
it is disabled for you. Unchanged content sends no update. If the Cloud Skill
differs, push lists what would change and refuses to overwrite it. Pull first
to keep Cloud changes, or use `--force` to replace it with the folder's content.
Read-only Skills cannot be changed; removed references are reported.
Symlinked Skill folders work too; links inside them must stay within the folder.

Cloud keeps `SKILL.md`, all extra frontmatter, and Markdown files directly in
`references/` with lowercase names (`a-z`, `0-9`, `.`, `_`, `-`). Push lists
skipped scripts, assets, agent settings, and other files. Cloud does not run
scripts.

Pull defaults to `.agents/skills/<name>` in the current folder. Existing files
cause an error before anything is written. Use `--force` to replace `SKILL.md`
and its references; other files, including scripts and old references, stay.

A Cloud-only Skill such as `assistant-code-mode` teaches Cloud tools. Pulling
it into a local folder gives other agents instructions for tools they may not
have.

## Share Projects and Skills

Both `cld assistant projects access` and `cld assistant skills access` provide:

| Command | Use |
| --- | --- |
| `list <resource>` | Show direct grants, names, account kinds, and access IDs |
| `grant <resource> --service-account <name-or-uuid> --permission read` | Add a direct grant |
| `set <resource> --service-account <name-or-uuid> --permission write` | Create or update a direct grant |
| `set <resource> --access-id <grant-id> --permission read` | Update one grant |
| `revoke <resource> --access-id <grant-id> --yes` | Remove one grant |
| `revoke <resource> --service-account <name-or-uuid> --yes` | Remove a recipient's direct grant |
| `search-principals <query> [--kind user,group,service_account]` | Search the directory for recipients |

A resource is its exact name or short ID. Recipient flags are `--user`,
`--group`, `--service-account`, and `--authenticated`; choose one. Human
recipients accept UUIDs, exact names, and, for users, uid or email. Service
accounts accept UUIDs or exact names. Ambiguous names fail before a write.
Name lookup and principal search require directory access. A userless actor
uses recipient UUIDs; the CLI does not grant it directory access.

Standalone and agent accounts can manage Projects within their grants and
the credential's `read`, `write`, or `admin` scopes. Creating a Project requires
`write` or `admin`. These accounts can also read Skills granted to them.
Skill access commands and other Skill writes require a user-backed caller
with Core access, even when a machine account has an `admin` grant and scope.
Resource-bound credentials are unsupported. Service accounts of kind
`user_delegated` or `resource_bound` cannot replace the last eligible manager.
Public grants are rejected. Grant changes require `admin` permission.

The established Project syntax remains accepted:
`projects access grant <project> <recipient> --type user|group|service_account`
(default permission `read`), `projects access update <project> <access-id>
--permission <level>`, and `projects access revoke <project> <access-id> --yes`.

## Assistant in editors

`cld assistant acp` (shortcut `cld acp`) runs Assistant as an ACP v1 agent over
stdin and stdout for editors such as T3 Code and Zed. It uses the signed-in
Cloud profile and the editor's project folder. Chats stay in Cloud.
Sending, deleting, sharing, and inviting wait for confirmation in Cloud; the
editor shows the chat link and can only reject these requests. Remembered
editor approvals last at most for the chat.

See [Assistant in editors](https://cloud.k2b.dev/en/docs/ai/editors) for setup,
commands, forms, and session behavior.

## Interactive and print modes

Start a line-oriented terminal session:

```bash
cld assistant
cld assistant "Summarize my open work"
cld assistant --chat <chat-id>
```

The session works in the folder where you start `cld ai`. Startup shows the
model, folder, local tools mode, loaded AGENTS.md files, and local Skill counts:

```text
Info: Local tools: ask · <folder> · AGENTS.md: 2 files · Skills: 3 project, 12 global
Info: Reads and creates files here freely; asks before commands, changing or moving files, and other folders. What it reads is stored in this chat and sent to the model. /permissions to change.
```

Starting in your home folder, `/`, or an ancestor of home asks for every file
access. `off` shows one local tools line. Declined folder instructions appear
as `AGENTS.md: not loaded`; a budget cut appears as `shortened`. New chats print
their resume command, and the CLI repeats it when the session ends. Blue `Info:`
messages confirm state changes.

| Command | Use |
| --- | --- |
| `/help` | Show the command list |
| `/new` | Forget the open chat; the next message starts one, keeping the model, Project, tools mode, and queued local files |
| `/resume [chat-id]` | Choose a recent chat or open its ID; attach to an active turn |
| `/project [project-id\|none]` | Choose an accessible Project, or remove it from the open chat |
| `/model [id\|default]` | Choose a model for this session |
| `/retry [retry\|details\|concise]` | Answer the last user message again, more fully, or more briefly |
| `/attach <path>` | Queue a local file for the next message |
| `/skills` | List local and enabled Cloud Skills, their origins, hidden entries, and discovery problems |
| `/<skill>` | Select a Skill for the next message; add text to send it immediately |
| `/files` | List files stored in this chat |
| `/web` | Print the Assistant URL and open it when a browser is available |
| `/status` | Show the profile, chat, model, Project, tools mode, start folder, AGENTS.md, and Skill counts |
| `/usage` | Show usage percentages, reset dates, and models with no limit |
| `/permissions [ask\|off]` | Change local tools mode; the picker can also save the profile default |
| `/approvals [approval-id]` | List remembered Cloud approvals and revoke one by number or ID |
| `/exit` | End the session |

Choice commands accept the value directly or show a numbered list. Enter
cancels, `0` selects the neutral value where available, and `[current]` marks
the current choice. `/attach` requires a path. An unknown command prints a
hint and is not sent to the model. An absolute path such as `/etc/hosts is
broken` remains an ordinary message.

Interactive sessions offer local tools in `ask` mode by default. Use
`--no-bash` for `off` in this session, `--allow-bash` for `ask` even when the
profile default is `off`, or `/permissions` to change the mode. The flags
cannot be combined. `/permissions ask|off` changes only this session; the
numbered picker can save the profile default. Saving `off` stores
`assistant.localTools`; saving `ask` removes it. In `off`, pending local calls
are denied too, including calls from a chat opened with `--chat` or `/resume`.
A retry retains its original tool set, but the current session still enforces
`off`. Print mode offers no local tools or folder context.

### Local files and questions

| Tool | What it does |
| --- | --- |
| `local_list` | List a folder, optionally recursively or with a case-insensitive glob; return sorted pages of up to 1,000 entries |
| `local_read` | Read numbered text lines in byte-bounded pages; upload PDFs, images, office documents, and spreadsheets for Cloud tools to read |
| `local_upload` | Upload up to 64 files sequentially; keep workspace-relative parent folders unless a chat directory is specified |
| `local_download` | Save a chat file locally; create a new file exclusively or replace an existing file after review |
| `local_write` | Create, append to, or replace UTF-8 text, up to 100 KiB per call |
| `local_move` | Review and move up to 64 files or folders within the workspace; report conflicts and any partial progress |
| `load_local_skill` | Load a trusted local Skill's instructions and list its supporting file paths |
| `local_bash` | Run a reviewed Bash command as your OS user, in the start folder |

Inside the start folder, listing, reading, uploading, and creating ordinary
files never ask. Appending, replacing, moving, and every Bash command ask.
Writing, downloading, or moving to `AGENTS.md` or anything under a `.agents`
folder also asks, even for a new file, because it becomes instructions for the
assistant. The check ignores case and follows symlinks; reading these files
stays free.
File questions explain when a path is outside the folder, may contain secrets,
or is subject to the home-folder rule. Uploads ask once for the files that
need permission; free files can still upload if you decline that subset.
Moves ask once with aligned source and destination names. Conflicts stop the
batch before the question; an error during execution reports what already moved.
Every local tool except Bash stops after 120 seconds of work; time spent on a
question does not count. An upload batch that runs out of time still reports
the files it uploaded.

Questions appear in the terminal with `[y/N]`. **Enter = No**; only typed `y`
or `yes` approves. Pasted or typed-ahead text cannot approve. Replacing a file
shows its size, modification time, and the new size. New files never replace a
file that appears meanwhile. Missing parent folders are created only inside
the workspace. Moves stay inside the workspace and are refused when you start
in home or above. There is no delete tool; deleting through Bash still asks.

Path rules follow real paths: symlinks count by their targets, and new files
count by their existing parent. Protected names ask even through an otherwise
ordinary alias: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`,
`id_ed25519*`, `.npmrc`, `.netrc`, `.git-credentials`, `.ssh/`, `.gnupg/`,
`.aws/`, and `.git/`. Folder walks show these directories but do not descend
into them or follow symlinked folders. cld's configuration is always refused.
Trusted Skill folders and the session folder can be read freely; they grant no
free write or upload access outside the workspace.

Uploaded files stay as chat files until the chat is deleted. Outside files go
to the chat root by default. A local folder named `project` or `skills` lands
below `/local/`, because Cloud reserves those chat folders: `project/Rechnung.pdf`
uploads to `/local/project/`. Use the returned chat path: Cloud may change a
filename to avoid a collision. CSV remains text; other binary files need
`local_upload` when a Cloud tool can read them.

Before Bash, cld shows the exact command and folder, then asks `Run? [y/N]`.
Approval is never remembered. Bash has closed stdin, a 120-second deadline,
and captured output bounded to 512 KiB per stream. It receives no `CLD_*`
environment variables; other variables stay available. The terminal shows the
captured output. Above 64 KiB combined, the tool result carries the start and
end of each stream and a path to the full captured output. cld creates a private
session folder under the system temporary directory only when needed (0700,
output files 0600); it is removed when the interactive session ends.

### Folder instructions and Skills

cld finds the nearest Git root above the start folder: a `.git` file, or a
`.git` folder with `HEAD`. Without one, the start folder is the root. It reads exact-name `AGENTS.md` files from
that root down to the start folder, root first and closest last, on every send.
AGENTS.md targets outside the real project root or on protected paths are
skipped and reported under **Problems**, even in a trusted folder.
The 32 KiB budget favors the closest instructions; shortened text is marked
and farther files are dropped.

Project Skills live in `.agents/skills/<name>/SKILL.md` along the same path;
global Skills live in `~/.agents/skills/<name>/SKILL.md`. Closer project Skills
win over farther ones, then global Skills, then Cloud Skills of the same name.
Aliases to the same real Skill folder are listed once. Unknown frontmatter is
accepted; `allowed-tools` grants nothing. Invalid Skills and shortened
descriptions appear under **Problems**. SKILL.md files larger than the public
Skill limits allow are skipped before reading. At most 64 local Skills,
including manual-only entries, are sent to Cloud per turn. `cloud-cli` is hidden
because cld already reaches Cloud through its own tools.

Before loading project AGENTS.md or Skills, cld asks you to trust the folder:
**Trust this folder** saves the root's real path in `assistant.trustedFolders`,
a JSON array in this device's cld profile defaults; **Only this session** does
not save it. Enter declines loading for the session. Global Skills do not ask.
The decision lasts for the session; file contents are reread on every send.
Trust allows instructions to steer work with your Cloud data; it does not
approve changes or commands.

`/skills` lists local and enabled Cloud Skills with origins, hidden duplicates,
and discovery problems. `/<name>` selects a Skill for your next message;
`/<name> <message>` selects and sends immediately. Up to four local Skills can
be selected together, and selections clear after sending. Built-in commands
win over Skill names. `disable-model-invocation: true` Skills are selectable
only through `/<name>`; they are excluded from the model's catalog. These
entries still hide same-named Cloud Skills for the turn. Local
Skills cannot be selected when local tools are off. Tab completes Skill names.

When the assistant writes a working plan, text output prints a checklist on
stderr: `[x]` completed, `[>]` in progress, and `[ ]` pending. Cancelled items
are omitted. The checklist appears in interactive and print mode.

### What leaves your computer

| Content | Where it goes |
| --- | --- |
| Messages and `@` or `/attach` files | The Cloud chat; the model receives message text and files it reads |
| Tool arguments and results | The Cloud chat and the model, including local text and Bash output |
| Uploaded files | Chat storage in Cloud; model or Cloud tools can read them |
| Trusted AGENTS.md, Skill names/descriptions, and selected or loaded Skill text | Cloud and the model with the turn or tool result |
| Workspace path, OS, and shell | Cloud and the model with every interactive message |

Preview the prompt for this computer with
`cld assistant prefs system-prompt --local`; it uses the profile's default
local tools mode, including its **Local client** section.

Cloud approvals use numbered choices: **Approve once**, **Approve for this
chat**, and **Always approve**, where the action permits them. Enter rejects.
When only one-time approval is available, the prompt is `Approve? [y/N]`.
Websites are never remembered from cld; website approvals saved in the web can
still be listed and revoked with `/approvals`.

A pasted block is one multi-line message; Enter sends it. A `\` at the end of
a typed line continues the message on the next line. Input typed while a turn
runs or while an editor is open is ignored, so it never answers the next
question. Pasted input never answers an approval, a numbered choice, or a
confirmation; survey answers accept pasted text.

At the prompt, Ctrl+C clears typed input and ends the session when the prompt
is empty. During a turn, Ctrl+C stops the turn, also while it waits for your
answer or runs Bash. At other questions, such as a numbered list, Ctrl+C
cancels the question and keeps the session open.

Mention `@path` to attach a local file like `/attach`; its bytes are stored as a
chat file in Cloud, and the message text stays unchanged. Each `@` file that
is attached prints an `Info: Attached:` line. Write a space in an `@` path as
`\ `, for example `@Rechnung\ März.pdf`; Tab completion inserts it this way.
Paths inside the start folder attach without a question, except protected
files such as `.env`, keys, and `.git/`, also when such a name is a link to
another file. Files outside that folder ask first. Starting in your home folder
or above asks for every file. cld's own configuration is refused. `--attach`
paths follow the same rules when the session starts. Tab completes slash
commands and `@` paths. Relative Cloud links in answers print as absolute links
to the selected server.

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
short chat and Project IDs above. Remembered approval IDs are also UUIDs;
use the exact ID from `assistant approvals list` when revoking one.

Useful options:

- `--title <title>` names a newly created chat and preserves that title through the first message and automatic enrichment. `chats create --title <title>` does the same. The CLI trims the title and checks the 1 to 120 character limit before creating anything. The exact title `New chat` matches the default placeholder and keeps automatic naming.
- `--model <profile-id>` selects a model from `cld assistant models`.
- `--project <project-id>` creates the new chat in an accessible Project.
- Repeat `--attach <local-file>` for local images or documents. This flag does not accept a Cloud resource ID and refuses cld's own configuration.
- `--detach` submits the turn and returns its ID without waiting in print mode.
- Repeat `--approve <exact-tool-name>` in print mode to approve only those tools for that turn. There is deliberately no approve-all flag.

Print mode writes assistant text and capability result tables to stdout and tool progress to stderr. Text output shows control and bidirectional formatting characters escaped, such as `\u001b`, so model text cannot restyle or hide later output; `--json` and `--jsonl` keep the text unchanged. Separate non-blank text blocks have a blank line between them, including in the final JSON result. Reconnects and interactive approvals continue with only new text and do not repeat unchanged tool progress; `turns watch` behaves the same way. Tool progress and `--approve` use canonical capability IDs such as `spaces.task.create`. JSONL `text_delta` events carry each block's new text once under the block ID that first carried it, without separators. `turn_finished` carries the complete text, also when the turn ended during a reconnect. Tables show up to 100 returned rows, shorten long cells for display, and include supplied result links. A notice identifies additional rows or pages. Use `--json` for complete returned cell values: it waits and prints one final aggregate without terminal tables. `--jsonl` emits versioned stream events such as text deltas, tool state changes, attention requests, provider retries, and turn completion. While a model call waits for its retry, print mode writes `model: reconnecting` to stderr. Each file the assistant delivers is named there with its chat path, such as `present: completed /sales-report.pdf`; download it with `cld assistant files download`. Structured output, detached submission, and piped input require `--print`.
`--allow-bash` and `--no-bash` are rejected with `--print`, including structured
output and detached execution. These modes offer no local tools.

The web composer and CLI share one durable conversation draft. Before a CLI turn in an existing chat, the CLI refuses to replace a non-empty unsent web draft. Send or clear that draft in Assistant, then retry the CLI command. This prevents a terminal turn from silently overwriting text, files, or Cloud resources prepared in another tab.

If a turn needs an approval or frontend tool result that was not supplied, the command exits with status `2`. Inspect and resolve it explicitly:

```bash
cld assistant actions list <chat-id> <turn-id>
cld assistant actions approve -- <chat-id> <turn-id> <call-id>
cld assistant actions reject -- <chat-id> <turn-id> <call-id>
cld assistant actions submit <chat-id> <turn-id> <call-id> --result-file result.json
cld assistant turns watch <chat-id> <turn-id>
```

In text output, `actions list` shows the same question, reason, and preview as
the chat card. People include their address. Dates use the terminal's time zone;
the question's locale controls labels. For example:

```text
? Send email “Maintenance” to Lea Berg <lea.berg@example.com>?
  I'm asking because this leaves Cloud.
  Mail · Chat “Maintenance”
  From:    Team Ops <ops@example.com>
  To:      Lea Berg <lea.berg@example.com>
  Subject: Maintenance
  Hello Lea, maintenance starts on Tuesday.
  Read all: https://cloud.example/mail/drafts/7?revision=2
  Send to Lea Berg: cld --profile work --server https://cloud.example assistant actions approve -- <chat> <turn> <call>
  Don't send:       cld --profile work --server https://cloud.example assistant actions reject -- <chat> <turn> <call>
```

The printed commands put the listing's profile and server before the module
name and quote every ID, so a copied command decides exactly this question.

Long bodies show up to eight lines, followed by `…`, only when **Read all**
opens the complete version; otherwise the whole text shows. Interactive mode
shows the same block before its approval prompt, and the validated input under
it when the call has no new review or the question leaves something out that no
link opens. JSON output retains the raw API response; JSONL
retains the existing action rows.

List and revoke remembered Cloud approvals without a REPL:

```bash
cld assistant approvals list
cld assistant approvals list --chat <chat-id>
cld assistant approvals revoke <approval-id>
```

Without `--chat`, the list contains approvals that apply everywhere; with it,
only approvals limited to that chat. Lists support `--json` and `--jsonl`.
Revoking needs no `--yes`: the Assistant asks again on the next matching call.

## Code Mode and Studio

Resource managers can use `assistant code database-status ID` without creating
a database, `database-export ID --out backup.sqlite` for a streamed backup,
and `database-reset ID --yes` to detach the current database and queue its
deletion. Reset preserves source, publications and shared files/KV. The next
connection creates a new empty database; retries cannot delete a replacement
created after the confirmed generation.

`assistant code storage-manage ID --input-file request.json` uses the existing
`area`, `operation`, `key`, `after`, `limit` storage contract with Manage access.
Use `assistant code storage-clear ID --area files|kv|all --scope shared|user --yes` for bulk cleanup. Scope defaults to `shared`; `user` clears only the current user’s personal JSON (`--area kv`).
These commands share the Studio Advanced menu's permission-aware services.
Personal JSON uses scope:"user" and always belongs to the signed-in viewer across devices.

In an Assistant chat, Cloud runs Code Mode on the server; of its tools, only
`code_open` and `code_secret` still wait for the CLI. `code run` and
`code action` run in an isolated browser worker hosted by the CLI. It does not
need an open Assistant browser tab. The served plugin includes Playwright and its browser metadata. Install Playwright Chromium, or set
`CLOUD_CLI_CHROMIUM` to an existing Chromium executable. A host that does not
start within 45 seconds fails without running code, and the error names the
startup step that stalled.
Streaming reconnects after transport interruptions and periodically reconciles
the saved turn state. This keeps a missed completion event from leaving the CLI
waiting indefinitely; it does not restart completed tool calls.
Code has no Node/Bun environment, shell access, credentials, or unrestricted
network access. This is separate from local tools in `ask` mode.

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

All reusable programs are Apps: an `index.html` interface, agent actions, or
both, with optional persistent data. One-off code belongs to its chat and
cannot be shared. Interfaces run in the browser; `code run` and `code action`
run scripts and refuse an `index.html` entry.
`code actions` reads the published `app.actions.json` contract without running
code. `action.json` contains `{id,action,publishedVersion,input}`; copy the exact
name and version from discovery and follow its JSON input schema. Use access
suffices for published handlers. `--draft` discovery and `{id,action,revision,input}`
require Manage and test the exact current draft. Supply one version selector.
A changed version rejects execution; rediscover before retrying. Action errors,
including invalid output, do not undo effects. The `code action` command uses
the same isolated host, approval flags, and optional steps as `code run`.

`run.json` contains either `{"code":"export default () => 42"}` for a one-off,
or `{"id":"<resource-id>"}` for a saved script. Add `inputPaths` for explicitly
selected files of the current chat; the script reads them on demand from its
context `files`. Actions and HTML apps receive no chat files. One-offs create no
Studio resource. Optional `--steps-file` accepts an array of `{name,args}` steps
using `code_inspect` or `code_export`; the CLI supplies the run ID. An export returns
an absolute chat-file path for `assistant files download` or a later run's
`inputPaths`. Snapshot output includes `outputTruncated`; export full results
instead of parsing a shortened preview. Pending input downloads pause startup
and readiness watchdogs, but still count toward the tool call's 45-second outer
budget. Capability approval waits pause that outer budget. At host capacity,
finished one-offs without exports, pending requests, or running jobs are
reclaimed automatically. Invalid tool arguments fail the command before source
execution. A started call that does not complete fails the command with
`{failed: true, error, guidance?}`.

For long work, use the script context signal and progress; yield between batches.
`code_inspect` accepts `waitMs` up to 30000. After explicit steps, the CLI keeps
its host alive until active background work finishes. Closing the CLI interrupts
the worker.

Lazy `cloud.pdf.read` reads PDF pages/text/positions; `cloud.sheet.read` detects
XLSX/ODS bytes and reads cached formula values. `cloud.sheet.toOds` exports
workbooks. No package imports are needed. Process selected files sequentially
and close PDF readers after use. Parser budgets are 64 MiB per document and
128 MiB expanded workbook XML. Selected chat inputs and captured exports retain
64 paths, 50 MiB per file, and 250 MiB total; use Blob for large exports.
Those are separate from persistent shared storage quotas.

Agent/CLI runs use the same personal and shared server stores. Storage changes are real
and persist across runs and publications. Forks start with empty data. Use
`code storage` with JSON input for file list/delete and KV operations. Use
`code sql` with `{"sql":"SELECT title FROM todos LIMIT 20","params":[]}` for
a direct read-only query. It never creates a database. `code database-connect`
explicitly provisions one when the instance has rsql configured;
`code database` sends flat `list/get/insert/update/delete/query` operations to the Use runtime and dotted `tables.*`, `schema.get`, and `rows.*` operations to Manage-only maintenance. Project membership grants Use on linked published Apps, including
read/run/storage/database commands and copying published source. A Project chat
is not required; editing and management rights remain separate.

Normal capability approvals also apply inside scripts. Interactive Assistant
sessions show the review and numbered approval choices when approval can be
remembered; one-time approvals ask `Approve? [y/N]`. An HTTP request from Code
Mode shows its method, URL, headers, and body preview in that review. For a
direct run or print-mode turn, repeat `--approve <exact-capability-name>` only for operations
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
and Project associations, not personal JSON storage.

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

## Routines

Routines belong to a chat, but each run uses an independent execution history.
It starts from completed chat context and reads current files, memories, and
Project knowledge and files. App reads, including Project references, need grants. Interactive chatting can continue while it runs. Results and
failures are delivered to the original chat, reopening it and updating its
activity time. One-time `--at` values are local wall-clock times in `app.timezone`,
with the exact format `YYYY-MM-DDTHH:mm`. Recurring routines use a five-field cron
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
creating a routine gives it no capability grants. Updating grants replaces the list.
Only Actions whose `approval` is `none` or `rememberable` can be granted; an Action
without an `approval` field in the catalog asks every time and cannot be granted.
`--yes` is required only for a non-empty grants list.

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
An existing remembered chat approval does not authorize a background routine.

Use `tasks status` before creating a schedule when you need to confirm the
effective application timezone. `tasks get` includes recent occurrence history. A terminal delivery or turn
failure moves the routine to `needs_attention`. Resume a recurring routine after
fixing the cause; a failed one-time routine needs a new future schedule via
`tasks update`. Deleting a routine deletes its history, and deleting its chat cascades
to the routine and all occurrences.

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

Personalization use and learning from chats are separate settings. Learning is on for users who have not chosen; a setting stored before learning became the default stays as it was, and `--learning` stores a new choice. Learning considers turns from the user's own chats, Project chats included, that finish while it is on, and only genuine user-authored text, not attached Cloud resources, files, tool results, scheduled prompts, inter-chat deliveries, or Assistant output. It keeps only information about the user, never facts about other people, and leaves Project facts in the Project. It skips sensitive categories such as health, religion, or political views unless the user explicitly asks to remember exactly that. Archived and deleted chats are excluded; after a chat is restored, learning considers only turns that finish later.

```bash
cld assistant personalization status
cld assistant personalization configure --use on
cld assistant personalization configure --learning on
cld assistant personalization configure --use off --learning off
```

## Projects

Projects combine shared instructions, knowledge, files, Cloud references, model defaults, and access grants that say who may use the Project. Chats created in a Project remain private. Knowledge and files are copies that every member can read; a reference is a live pointer that the Assistant reads with each member's own access and that grants nothing. Reference types are `<app>.<type>`, such as `notebooks.note`, `spaces.space`, `grids.base`, or `mail.mailbox`; see [How the Assistant works](how-it-works.md).

```bash
cld assistant projects list
cld assistant projects create "Release notes" --instructions-file ./release-notes.md
cld assistant projects knowledge add "Release notes" "Editorial guidelines" --content-file ./guidelines.md
cld assistant projects files put "Release notes" ./glossary.csv
cld assistant projects references add "Release notes" grids.record <record-id> --label "Current catalog"
cld assistant projects access grant "Release notes" --group "Editors" --permission write
cld assistant chats create --project <project-id>
```

Skills and Projects require authentication, including direct API requests.
Public grants are rejected; share with users, groups, service accounts, or all
authenticated identities instead. Project sharing does not share private chats.

Project names and short IDs are accepted by management commands. Access grants use `read`, `write`, or `admin`. The creator starts as `admin`, and a Project always keeps at least one `admin`.

Run `cld assistant <group> help` or `cld assistant <group> <command> --help` for the complete accepted flags.

Resource deletion requires Manage access and removes publications, grants and
shared and personal server data; remote database cleanup is queued. Running resources without Manage access requires per-call capability
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

The administrator input is `{"fileMiB":50,"totalMiB":250}`. Omit fields you do
not intend to change. Reads also report `unreadable` by setting name. Replacing
an unreadable value requires its name in `replaceUnreadable`, for example
`{"fileMiB":50,"replaceUnreadable":["assistant.storage_file_mib"]}`. Database
configuration accepts the same replacement list for `assistant.rsql_url` and
`assistant.rsql_api_token`; omitted values stay untouched. Ordinary writes over
unreadable values return HTTP 409 `setting_unreadable`.

Those are also the
default byte budgets in MiB. There is no shared file count limit. File size can
be configured up to 64 MiB, total storage up to 1 TiB per resource. Shared KV
retains its separate 16 MiB/1,000-entry budget. Lists use `after`/`limit` pages.
An upload replaces the named key; use another key to keep both originals.
Lowering budgets preserves files and permits reads/deletes or non-growing
replacements. Storage settings do not raise chat or processing limits.
Direct JSON file read/write is no longer accepted; use the binary commands.


### PDF generation and Finance in Code Mode

Code run through the CLI uses the same Studio APIs: `cloud.pdf.render`, `cloud.pdf.attach`
and `cloud.pdf.render({html,facturX:{xml,profile}})` return Blobs through the configured Gotenberg service.
`cloud.download(name,data)` captures the result for an explicit export step. PDF calls use
binary multipart, preserve cancellation across the browser subprocess, and do
not need `--approve` for the internal conversion. App Use access or an accessible
unrestricted chat is required; source editing and resource maintenance retain
their existing Manage requirement.

`cloud.finance.camt.parse` and `cloud.finance.einvoice` methods are awaited,
alongside `cloud.finance.datev` and `cloud.finance.sepa`. `cloud.money` handles
exact arithmetic synchronously. No WASM/XSD checker is included.
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
personal JSON storage. It never grants app database, server files/KV, secrets,
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
