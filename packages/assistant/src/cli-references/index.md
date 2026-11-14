# Assistant CLI

Use `cld assistant` for interactive access to the user's personal Cloud agent and for chat automation. Assistant is the CLI and GUI surface for personal conversations stored by Cloud AI Core; chats started from Mail or another application appear in the same history. The root command starts or continues a chat, while named management commands inspect chat state and files, resolve pending actions, manage personalization, and manage Projects.

`cld ai` is a short form of `cld assistant` for people typing in a terminal; agents keep using `cld assistant`.

Before you configure the Assistant for someone, read
[How the Assistant works](how-it-works.md) (`cld assistant reference how-it-works.md`).
It explains whose permissions the Assistant uses, what Projects share and
whether it is live, which Actions need approval, and when to use instructions, Skills, memories, or knowledge.
Scheduled chat routines and their management commands are retired; `tasks export` reads frozen definitions only.

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
editor approvals last at most for the chat. Local Bash is offered only to
editors with form support, because an editor can answer its permission prompts
automatically.

See [Assistant in editors](https://cloud.k2b.dev/en/docs/ai/editors) for setup,
commands, forms, and session behavior.

An editor saves folder trust only through a form; without forms, folder
instructions load for one session.

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

Remembered approval IDs are also UUIDs;
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

## Chat code

One-off `code_run` tool calls in chat execute on the Code runner with the turn's
approvals. Read returned results through the chat. Use `cld code` for lasting
Code. The former `cld assistant code`, `studio-admin` and `code-host` commands
have been retired, including HTML checks and Studio app storage.

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

## Routines became Code

Scheduled chat routines and their management commands are retired. `cld assistant tasks export` still reads frozen definitions. Ask Gustav to rebuild an exported definition as personal Code with `app.schedule`, an explicit `timeZone`, and `core.ai.chat.run`. Review the Code and its grants before activation. Old runs cannot resume.

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

Personalization use and learning from chats are separate settings. Learning is on for users who have not chosen; a setting stored before learning became the default stays as it was, and `--learning` stores a new choice. Learning considers turns from the user's own chats, Project chats included, that finish while it is on, and only genuine user-authored text, not attached Cloud resources, files, tool results, scheduled prompts, Code-started prompts, inter-chat deliveries, or Assistant output. It keeps only information about the user, never facts about other people, and leaves Project facts in the Project. It skips sensitive categories such as health, religion, or political views unless the user explicitly asks to remember exactly that. Archived and deleted chats are excluded; after a chat is restored, learning considers only turns that finish later.

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

### PDF generation and Finance in chat code

Chat scripts can use `cloud.pdf.render`, `cloud.pdf.attach`, `cloud.pdf.read`,
`cloud.sheet` and `cloud.finance`. PDFs are generated through Gotenberg;
financial calculations and input parsing run in workerd. Export captured files
through `code_export`, then present the returned chat path.

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
remain.

`cld assistant tasks export --json` preserves all your routine definitions,
including prompts, schedules, timezones, grants, mandate summaries, state and
target chats. Cloud administrators use `--all` to export the installation.
Exports grant no access. JSON and text output are one JSON document; JSONL
is one API page per line. Export before an upgrade removes routines.
