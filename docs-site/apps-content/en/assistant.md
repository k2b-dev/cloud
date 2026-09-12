---
title: Assistant
navTitle: Assistant
section: Work
order: 100
description: A personal AI workspace for conversations, files, Projects, and reusable preferences.
tags: [assistant, ai, chats]
updated: 2026-09-11
---

# Assistant

The **Studio** navigation opens a server-rendered, full-width gallery of apps you can access.
The initial cards and page navigation use server data without a browser loading step. Launch
a published app without opening a chat. Apps use Cloud person and group grants:
**Use** allows running and copying the published version; **Manage** also allows
editing, publishing, and changing access. Administrators can see unpublished drafts.

The tile menu provides **Edit**, **Manage access**, and **Publish** for administrators.
**Edit** opens a new chat with the app attached, ready for your instructions. It
does not send a message. Saving code updates the working draft. **Publish** makes
that tested version available to users; later edits do not change it. Running apps
keep their inputs and offer a restart when a newer publication becomes available.

**Create your own copy** copies published source into a private draft. Chats,
access grants, and browser data are not copied. All administrators of one app edit
the same working draft, so coordinate simultaneous changes to the same file.

Assistant is a personal AI workspace for writing, explaining, planning, and
working with supported files. Chats belong to the current user and remain
available when the work continues later.

## Use Assistant

- Start a chat from a suggested task or write your own request. Before the first
  message, optionally choose a Project below the composer to use its shared
  context.
- Attach source files or Cloud resources when the answer must use material
  beyond the message. Files and screenshots can also be pasted directly into
  the composer. A long plain-text paste becomes a durable **Pasted text** attachment;
  **Show in text field** moves a bounded text attachment back into the draft.
  You can attach up to 16 items.
- Ask Assistant to read supported PDF, Office, OpenDocument, RTF, EPUB, or CSV
  attachments, or to inspect an image.
- Give Assistant an exact public HTTPS file link to import that image, document,
  or raw repository file into the chat before inspecting it. Assistant cannot
  authenticate to private downloads or clone and browse a repository through
  that link.
- Ask for a PDF when the result should be downloadable. Assistant first writes
  or edits a Markdown file in the chat, converts it with an optional A4 print
  preset and custom CSS, then presents the generated PDF.
- Find saved chats in the sidebar, Projects, search, or **See all**.
- Fork a useful point when another direction should not replace the existing
  conversation.
- Choose a model when the task needs a capability that the default model does
  not provide, and review requested actions before approving them.

The Sources panel shows the latest web search query above “Searched the web”.
Extracted pages show their title and description.

Assistant can make mistakes. Check consequential facts, calculations, and
proposed actions before relying on them.

## Understand the Assistant model

| Resource or surface | Responsibility |
| --- | --- |
| Chat | One user-owned conversation with a name and optional description |
| Message and turn | A request and the assistant run that answers it |
| Chat files | Source files and editable artifacts kept with one conversation |
| Personalization | User-scoped facts, preferences, and Cloud workflow defaults applied across conversations when enabled |
| Skills | Shared reusable workflows that each user can enable or disable for themselves |
| Remembered approvals | User-managed choices for bounded Actions that may run without asking each time |
| Project | Shared instructions, knowledge, files, references, and defaults used by private chats |

Project members with write access can manage knowledge, files and Cloud
references. Project administrators manage instructions, the default model and
access. Reference search can be narrowed to one Cloud application.

Project chats present that shared context together with chat sources and files,
but Project editing remains on the Project page. Instructions and knowledge
open as rendered Markdown, images open in the image viewer, and files open in
the file browser.

Readable Skills start enabled for each user. Open **Assistant settings → Skills**
to disable a Skill only for yourself or enable it again. This personal choice
does not change the Skill's Cloud access or availability for other users.

The empty chat keeps the composer in the center and offers editable starters
for common mail, scheduling, Cloud search, and planning work. Choosing a starter
fills the composer without sending it. You can choose or change the Project
between turns; the change applies to future turns.

A model profile selects the provider model and available capabilities for a
turn. Assistant lists streaming, tool-capable models so stored chat and Project
images can be inspected again through `view_image`. Retry reruns a message in
the current branch. Fork copies the conversation through a selected message
into a new chat.

## How Assistant fits Cloud

Assistant owns its chat workspace and user experience. It uses Cloud's shared
AI runtime for conversations, model selection, streaming turns, files, Projects,
personalization, tool approvals, maintenance, and completion notifications. Cloud
identity keeps each personal workspace bound to a user.

After a connection interruption, Assistant reloads the current chat and resumes
updates.

## Find detailed product help

Open **Help** inside Assistant for chats, message actions, files,
personalization, and guidance for better requests. Developers can read
[Chat runtime and streaming](/en/docs/ai/chat-runtime-and-streaming),
[Files, Projects, and personalization](/en/docs/ai/files-projects-and-personalization), and
[Tools and approvals](/en/docs/ai/tools-and-approvals) for the shared contracts
Assistant adopts.

Open **Assistant settings → Approvals** to review Actions previously accepted with
**Always approve**. Revoking an entry makes Assistant ask again on the next
matching call. Sending email, deleting data, open-world effects, and other
Actions with the default approval policy continue to require confirmation every
time. Code Mode source and execution tools run without confirmation within the
user's existing permissions; they do not grant sharing or app deletion.

## Use Assistant from the terminal

Assistant provides one native CLI entry point for interactive work and
automation:

```bash
cld assistant
cld assistant "Start with this request"
cld assistant --chat <chat-id>
cld assistant -p "Print one response and exit"
```

Interactive mode streams replies into the terminal and keeps the same chat for
later prompts. Use `--print` or `-p` for scripts, pipelines, structured output,
or one request without a prompt loop. Its startup line shows the effective
model. A new chat prints its stable `cld assistant --chat <chat-id>` resume
command, and the CLI repeats that command when the session ends. Blue `Info:`
messages confirm non-error state changes such as attachments, model selection,
and stopped turns. Run `/model` without an argument to select an available
model by number. The model remains active for the session.

Use `cld assistant --allow-bash` when the Assistant must work on the computer
running the CLI. This exposes a local Bash tool only for that interactive
session. Every requested command is shown and requires a fresh `Y/n`
confirmation. Commands run with the current OS user's permissions in the CLI's
startup directory, and their bounded output is stored in the chat and sent to
the model. The web app can display these calls later but cannot run them.

The interactive CLI offers `a` for **Always approve** only when the pending
Capability Action supports remembered approval. Print mode never creates a
remembered approval, and local Bash always requires a fresh confirmation.

Start with these read-only checks before choosing a model or continuing a chat:

```bash
cld assistant status --json
cld assistant models --json
```

Run `cld assistant help` for chat flags and the management commands for chats,
messages, files, preferences, Projects, and turn actions. Run
`cld assistant <command> --help` before approving or changing stored state.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

### Find dictation recordings

Recordings made with the composer microphone appear under **Voice inputs** in
the context panel and file picker, labeled with their date and time. They remain
stored conversation files that Assistant can read or transcribe again. Audio
files you attach yourself remain in the regular chat files.

### Studio publication versions

Sharing and publication are independent. Publishing a personal application never
adds access grants. **Start** runs the current publication; before the first
publication, administrators can start their working application normally.
Use-level users only receive the latest publication, never working source or
historical versions. There is no preview mode.

Each publication receives a sequential number, author, date, and required change
note. The agent can use `code_publish`, `code_versions`, and `code_restore`.
Restoring copies published code, title, description, and icon into a new working
revision and a new latest publication in one transaction. Its automatic note is
"Restore version X". Historical publications and user data remain intact. Source save revisions and publication
numbers are separate. Expected working revisions prevent stale publish/restore.

Administrators can select a historical publication in the runner's **Versions**
dialog and start it for themselves without changing the version other users get.
Starting a different version restarts that local session. **Restore**
atomically appends a new latest publication and updates the working source, with
an automatic "Restore version X" note. It preserves history and user data.
The compact Versions dialog sits in the bottom console toolbar. Before the first
publication, it offers a Publish action.
`code_update` changes working title, description, or Tabler icon. The code-mode
skill includes a short icon list. The compact Studio cards expose publication
status and put their action menu at the top right. Each app has a stable, subtle
color gradient, with its title and description beside its icon.

The first publication uses the note "Initial release" without a change-note prompt.
Later publications ask what changed. The access dialog warns that unpublished
apps are visible and usable only by administrators, even when Use access is granted.

### Analyze once or save a script

Code Mode uses direct Assistant tools named `code_*`, loaded individually when
needed. They are not Cloud capabilities and cannot be called through
`capabilities.run`. Source operations and SQL execute on the server; code runs
and UI interaction use the connected browser or CLI host. The GUI, tools, and
CLI use the same permission-aware resource services.

Ask for an analysis, calculation, or file conversion directly in the chat. Code
mode can run a one-off script and return findings or output files without
creating an app. Reusable scripts can instead be saved, published, shared, and
copied. Studio separates **Apps** and **Scripts**; one-off runs do not appear in
its galleries.

Scripts can receive selected attachments from their current chat. Apps request
files through their own upload controls and never gain implicit access to chat
attachments. A Project administrator can associate a published script with a
Project when they also manage the script. Current members can then use it in
that Project's chats. This does not grant editing, copying, or global Studio
visibility; those require separate resource access.

### Store data and combine Cloud actions

Saved resources can keep files and key/value data locally in the current browser
or share them through server storage. Data belongs to the resource across
publications. A copy starts empty. Agent test runs use temporary local storage,
but shared writes and Cloud actions affect real resources.

A resource can explicitly connect a database when it needs structured records.
Creating an app does not create a database. Database support requires an
administrator-configured rsql server and secret API token. Without it, connecting
fails with an explanation; apps that do not use a database continue to work.
SQL queries support SELECT; schema and record mutations use structured calls.
The agent can inspect an existing database directly with `code_sql`
without writing a script. The CLI equivalent is `assistant code sql`; neither
creates a database nor bypasses resource permissions.

Code can combine discovered Cloud capabilities through `capabilities.run`.
Normal access checks and action approvals still apply. Required confirmations
appear in the chat or app, with remembered approval when the action supports it.
Code cannot approve its own actions.

### Run code from the CLI

`cld assistant code run --chat CHAT --input-file run.json` uses an isolated
headless Chromium host without requiring a model turn or an open browser tab.
The input contains either a saved resource `id` or a one-off `code` entry.
Optional `inputPaths` select chat files for scripts; an admin can select a
published `version` for a saved resource.

Use `--steps-file` for subsequent inspect, interaction, or file-export steps in
the same run. The host waits for background work to finish before the command ends; a pending
app dialog needs an explicit interaction step. The host closes when the command ends. Exported files remain in
the chat. Capability actions need explicit `--approve` authorization or the
interactive chat approval flow. The CLI needs Chromium installed through
Playwright, or `CLOUD_CLI_CHROMIUM` pointing to an installed Chromium executable.

### Administer Studio

The Assistant administration page lists all saved apps and scripts, their shared
file and key/value counts, and whether they have a database. Administrators can
manage access, delete resources, and configure or test the rsql connection.
The stored API token is never returned. Removing or changing the server is
blocked while databases or queued database cleanup still depend on it.

Deleting a resource removes its source, publications, grants, and shared data;
remote database deletion is queued for cleanup. The inventory cannot count or
remove private browser-local files. The same management operations are available
under `cld assistant studio-admin`.

### Process large local document folders

Code Mode includes bundled PDF.js text extraction and read-only XLSX parsing.
Apps can select thousands of files, including subfolders, without uploading
original documents. File references cross the worker bridge; bytes are read on
demand. Relative paths distinguish equal basenames. Scripts may instead select
existing chat attachments; app tests can use those only as explicit picker
fixtures, never through implicit access to chat files.

Background work reports progress and supports cooperative cancellation. A stuck
worker is terminated after 15 seconds without a responsive heartbeat; this is
not a total processing timeout. Closing, reloading, or suspending the execution
host can interrupt work. Completed external writes are not undone by stopping.
Agents and CLI steps can wait with `code_inspect` and `waitMs` (up to 30 seconds).
The returned work status distinguishes running, completed, cancelled, and failed.

Parsing budgets apply per document: 64 MiB input and, for XLSX, 128 MiB expanded
ZIP entries. Process and close documents sequentially to bound memory. There is
no OCR, Excel formula execution, XLS/XLSB support, or Excel writer. Use CSV for
exports. PDF text includes page and position information; format-specific
invoice parsers still need representative document validation.

Chat test inputs and captured outputs use the existing 50 MiB-per-file and
250 MiB-total chat budgets, with at most 64 selected/captured files. Script
inputs are fetched on demand. Input reads pause the 15-second startup watchdog
and the agent host readiness guard. A tool call still has a 45-second outer
budget including compilation and transfers; capability approval waits pause
that budget. Native file-picker waits do not consume the startup watchdog.
Large exports use Blob rather than JSON strings.
User downloads are not accumulated as captured outputs. Browser-local storage,
shared storage, chat uploads, and source history are separate budgets. Shared
storage counts decoded data and allows transport encoding overhead. Local/shared
key listings accept `after` and `limit` for pagination.

Source history reclaims oldest unpublished revisions when its 250 MiB budget
fills. Current source and published versions remain protected. If these alone
fill the budget, saves fail atomically; a separate copy starts fresh but does not
copy data or grants. Active runtime calls renew their execution ownership, so a
long human approval does not make a second tab report a fixed-time interruption.
An expired host is never replaced by automatic replay of an uncertain action.

Database and other coded host errors preserve `error.code` in scripts as well
as a readable message. For example, handle `DB_NOT_CONFIGURED` by explaining
that the instance administrator must configure rsql; do not parse translated
error text or silently select another database.

Finished one-off runs without UI, exports, pending requests, or running jobs are
reclaimed automatically when the host reaches its 32-run limit. Saved resources
and retained runs require explicit stopping. Snapshot output previews are capped
at 16,000 characters and include `outputTruncated`; use file export for complete
results. Invalid tool arguments return `kind: "input"` before source execution.
