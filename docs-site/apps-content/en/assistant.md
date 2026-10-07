---
title: Assistant
navTitle: Assistant
section: Work
order: 100
description: A personal AI workspace for conversations, files, Projects, and reusable preferences.
tags: [assistant, ai, chats]
updated: 2026-10-07
---

# Assistant

## Background tasks

The built-in **scheduled-tasks** Skill guides Assistant through one-time
reminders (“Remind me tomorrow at 09:00”), recurring work, and repairing failed
tasks. It helps select the needed tools and propose task-specific approvals.
You can change the instructions, timing or approvals in the normal chat.

Ask Assistant to run a task once or on a recurring schedule. Each run starts
with the completed chat context available at that moment and works independently,
so you can continue chatting. Files, memories, Skills, and Project resources stay
live; they are not copied into a frozen workspace. A schedule has at most one
queued or running occurrence; ticks during that run are skipped. Different
schedules can run independently in the same chat.

The **Background activity** view lists runs across your chats. Open a run to read
its result and inspect its history, or return to the chat to adjust the task.
Results and failures arrive as ordinary messages. A new result reopens a completed
chat and moves it to the top of recent activity. Chats with active schedules show
a clock and do not become done automatically. Marking a chat done manually does
not pause its schedules. After a successful Done action, the card briefly shows
green confirmation before fading out. Failed requests leave it in place.

Before enabling a task, approve its capabilities and any fixed inputs. For example,
fixing `noteId` permits updates only to that note. Leaving inputs unrestricted
permits any input allowed by your existing access. These approvals belong only to
the task; they do not grant additional resource permissions. Actions that require
a fresh confirmation every time cannot run unattended.

If a run fails or lacks permission, ask in the original chat to change its
instructions, schedule, or approvals and try again. Expanding its approvals needs
confirmation. Failed runs remain available for inspection. Do not blindly repeat
a write whose outcome is unknown. Browser interaction and Code Mode are unavailable
in background runs. Background runs do not compact the parent chat; a run that
exceeds its context or runtime limit reports a failure.

The workspace panel opens during server rendering when a tab is selected in the URL,
using the saved panel width. A loading placeholder reserves its space until the
interactive content is ready.

Scheduled tasks are planned and adjusted in the chat. The context panel lists tasks;
each opens in its own reusable workspace tab with the latest result, run history, and
allowed access. “Adjust in chat” prepares a task reference and editable message in
the owning conversation without sending it or replacing an existing draft. Additional
permissions still require approval. The standard approval card describes each allowed
action and its fixed inputs using localized capability metadata instead of a JSON
grants dump. Each permission shows its action and app on one line, followed by
its fixed inputs or a short unrestricted-content notice.

The next run is shown in relative time. Hover over it for the exact date and
timezone. **Run now** confirms that a run was requested; its queued or running
status and final result update in the task panel automatically.

Background activities show compact answer previews. Open a run for its instructions
and result; **Run history** opens a separate read-only chat view with tool calls.
A neutral **Finished** status means the run ended, not that its goal succeeded.

## Studio

The **Studio** navigation opens a compact app list on hover or click, just like
**Projects**. It loads accessible apps when opened and includes page controls and
a **Search apps** button. Search opens global search with one **Studio** context chip and an empty
search field, matching app titles and descriptions. Apps are created by Assistant, so there is no creation
button. On mobile, tap **Studio** to open the same list in a dialog. Both surfaces
show a scrollbar and the standard scroll-edge fade when more apps are available. Projects and
Studio desktop menus, and the mobile Studio dialog, keep a fixed height of 450 px (at most 60% of the viewport)
while loading or showing empty, failed, or populated lists. Long lists scroll
inside that area. Desktop menus align their bottom edge with their navigation item. Mobile Projects remain expandable in the navigation.

There is no separate Studio overview page. Old `/app/assistant/apps` links, the
Studio breadcrumb, and deleting the currently open app return to Assistant with
the app-list dialog open. Closing the dialog leaves you in Assistant.
Select an app to open it directly, without opening a chat. Apps use Cloud person and group grants:
**Use** allows running and copying the published version; **Manage** also allows
editing, publishing, and changing access. Administrators can see unpublished drafts.

The app detail action menu provides **Edit**, **Manage access**,
and **Publish** for administrators. It retains the same actions as app cards
inside chat context, including copying, deleting, and advanced tools.
**Delete** is the final menu entry, under **Danger zone**.
In the runner, **Create your own copy** first explains what is copied. Confirming
creates your own draft from the published code, without data, secrets, or sharing
settings, and opens a new chat with an unsent customization prompt. Secrets
are available in management only.
**Edit** opens a new chat with the app attached, ready for your instructions. It
does not send a message. Saving code updates the working draft. **Publish** makes
that tested version available to users; later edits do not change it. Running apps
keep their inputs and offer a restart when a newer publication becomes available.


Project managers can change direct grants under **Project settings → Access**.
Add people, groups, service accounts or all signed-in users, choose View, Edit or
Manage, or remove a grant. Changes apply immediately; the last administrator
cannot be removed. Projects cannot be shared publicly.

### Link Studio Apps and Skills to a Project

Use **+** beside **Studio Apps** or **Skills** in a Project. The dialog has a
search field, a list of resources you manage, and a notice explaining inherited
access. Select a result to link it. Existing links appear under the section
heading and are rendered on the server with the initial Project context.

Linking or unlinking requires **Manage** on both the Project and the resource.
Project members inherit **Use** on published Studio Apps, including shared app
data, in Studio, the standalone runner, tools and CLI. They inherit **Read** on
Skills, including instructions and references. No editing or management rights
are inherited. App drafts remain private to app managers.

The app or Skill permission dialog lists linked Projects and explains the
inherited access. Private Project names are hidden from resource managers who
cannot access those Projects. A link remains in place if its creator later
loses access or management rights. Current Project membership still determines
inherited access. Unlinking or losing Project access removes only that inherited
access; direct grants and access through other Projects remain.

Linked Skills enter the normal enabled Skill catalog. Assistant loads their
instructions when needed; linking does not insert all instructions into every
chat. Personal disabled-Skill preferences still apply. Skills never grant access
to Studio Apps or external resources mentioned in their instructions.

### Standalone apps and public links

Studio opens the standalone runner for users with **Use** access. App managers
enter the management view and select **Open fullscreen** in the header or action menu. The
runner offers **Manage** and a personal action menu beside **Restart** and
**Stop** in the bottom toolbar. The app fills the page and scrolls inside its
own frame. Restarting shows progress in the button without adding a status row
or moving the app. This distinction uses app permissions, not the global Cloud
administrator role.

An app starts on its own only for people who manage it. Everyone else sees the
app's name and **Start**, so code someone else wrote never runs just because a
page opened. If an app's last start in this browser tab never finished, for
example because of an endless loop, it does not start on its own again; the page
explains this and offers **Start**.

App managers see a **Draft** or **Published** badge beside the runtime controls.
Select it for a short explanation and a **Publish** button for saved drafts.
Publishing selects a runnable version; it does not grant public access.
**Open fullscreen** stays visible for drafts and offers publishing first.

The runner's action menu keeps **Create your own copy**, **Secrets** and
**Personal data** available to authorized users. Personal JSON lives on the
server and follows the signed-in user across devices. Anonymous visitors have
no personal storage or server features.

**Copy app link** copies `/app/assistant/apps/ID/run`. This URL always runs the
latest publication, even for managers. It loads no Assistant sidebar, chat list,
chat updates, code editor or database console. Apps require sign-in and app
access.

Public links are switched off for now. **Manage access** no longer offers
**Public**, and a public grant is refused with `PUBLIC_SHARING_OFF` through every
interface. A public entry created earlier stays listed with a note, so managers
can remove it, but it opens nothing: visitors without an account are asked to
sign in. Public links return once apps run on a domain of their own, where an
app's page cannot pose as a Cloud page. Until then, share apps with people,
groups or all signed-in users.

Cloud administrators can add this URL as a **Link** in the navigation settings,
with a title, icon and audience. The shortcut's audience controls visibility,
not permission to run the app. CLI users can obtain the path with
`cld assistant code url ID` and use the existing grant/change-grant commands.

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
- Ask for a PDF when the result should be downloadable. For a text-first
  document, Assistant writes or edits a Markdown file in the chat and converts
  it with an optional A4 print preset and custom CSS. For a designed layout such
  as a letter, invoice, or certificate, it writes an HTML file with its own CSS.
  That file can have a header and footer with page numbers, a chosen paper
  size, orientation, and margins, and images and fonts from the chat's files.
  Both paths render offline, so remote images, fonts, stylesheets, and scripts
  are not loaded. Assistant then presents the generated PDF.
- Ask Assistant to save a PDF in Files when it should outlast the chat. You
  review that upload like any other Action.
- Find saved chats in the sidebar, Projects, search, or **See all**.
- Fork a useful point when another direction should not replace the existing
  conversation.
- Choose a model when the task needs a capability that the default model does
  not provide, and review requested actions before approving them.

The Sources panel shows the latest web search query above “Searched the web”.
Extracted pages show their title and description.

Assistant can make mistakes. Check consequential facts, calculations, and
proposed actions before relying on them.

## Keep active chats in view

Chats automatically move to **Done** after seven days without use. Sending a message, starting a run, or explicitly reopening a chat counts as use. Opening or reading a chat only marks it as read; it does not reset the activity timestamp. Background metadata changes do not count as use. Running chats and chats waiting for confirmation stay active. **Reopen chat** keeps a chat active until you mark it done again.

The sidebar shows one chat list with pinned chats first, marked by a colored pin instead of the chat or Project icon. **Done** remains a separate collapsible section.

**Projects**, between Studio and Personalize in the footer, opens the same preview popup as chat rows: hover or click it to choose a Project, create one with **+**, or open global search with the **Search Projects** button. The search shows one **Projects** context chip and matches accessible Project names and descriptions. Removing that chip returns to global search.

Inside a Project, **Search chats** opens global search with the Project name as
a context chip. Results are limited to your chats in that Project.

The main sidebar search button has a different purpose: while a Project is open, it searches your own chats within that Project using a removable Project context.

On mobile, expand **Projects** to reach the same destinations and actions. Project chats remain in the main chat list with the Project name on each card. **Done** includes the **All chats** entry.

Choose **Mark chat done** on a sidebar row when its work is finished. Stop a
running response first. Done chats move into the collapsed **Done** section;
their files, apps, history and pinning remain available. Choose **Reopen chat**
to bring one back, or send a new message to continue it. A finished response
does not automatically mark the whole chat done.

Hover over a chat for its description, Project, last model, apps, files and
**Chat settings**. Touch devices provide an information button; keyboard users
can reach the same preview with Tab. Resource details load when the preview
opens. **All chats** inside **Done** includes a searchable, paginated **Done** filter.

The CLI supports `cld assistant chats done CHAT`, `chats reopen CHAT`, and
`chats list --lifecycle active|done|all`. Archiving remains a separate action.

Pinned chats always remain active, overriding explicit or automatic completion. Unpinning reveals the underlying completion choice again. The sidebar hides the Done action for pinned chats; pinning and unpinning are available directly in the chat preview.

Chat selection responds immediately while details load. Previously opened chats reuse their cached content while refreshing; switching does not wait behind a page transition.

Active chats use context cards with an ellipsized title. Completed chats remain simple rows. New responses and requests for input use accent colors.

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

## Follow ongoing work

Chat cards show the current task and completed-task count while an agent works.
Open the chat preview to see its last tool. Reading a chat does not move it to the
top of the list.

Send another message while a response is running to add it to that chat's queue.
It starts after the current response ends, even if you switch chats or reload.
You can edit queued text or remove a message before it starts. Attachments and
resource references stay with the queued message. A failed dispatch offers
**Retry** and holds later messages until you retry or remove it. Each chat can
hold up to 32 messages with at most 250 MiB of queued attachments.

Use the separate steering action when you want to influence the current response.
Stopping a response does not remove messages already in its queue; remove those
entries if you no longer want them to run.

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
user's existing permissions; they do not implicitly grant sharing or app deletion.

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

Assistant can manage requested sharing without opening Studio. It resolves recipients
through the permission-aware `core.entities.search` capability and reads current
App grants with `code_access_read`. `code_access_change` presents the exact
recipient and before/after permission for fresh confirmation. App levels are
Use (`read`) and Manage (`admin`); supported recipients are users, groups, and
all authenticated users. Public grants support only isolated execution of the published App. Service-account App grants are unsupported.
Concurrent changes invalidate the reviewed grant revision; the last manager
cannot be removed.

Skill sharing uses `core.ai.skill.access.read` and
`core.ai.skill.access.change`, with Read/Edit/Manage (`read`/`write`/`admin`).
A Skill and an App referenced by that Skill have independent grants. Sharing
one never shares the other. The agent explains missing access and prepares each
requested change separately. Access tools load only for sharing tasks.

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

Administrators can select a historical publication in Studio management's **Versions**
dialog and start it for themselves without changing the version other users get.
Starting a different version restarts that local session. **Restore**
atomically appends a new latest publication and updates the working source, with
an automatic "Restore version X" note. It preserves history and user data.
The compact Versions dialog sits in the bottom console toolbar. Before the first
publication, it offers a Publish action.
`code_update` changes working title, description, or Tabler icon. The code-mode
skill includes a short icon list. App cards inside chat context expose publication
status and put their action menu at the top right. Each app has a stable, subtle
color gradient, with its title and description beside its icon.

The first publication uses the note "Initial release" without a change-note prompt.
Later publications ask what changed. The access dialog warns that unpublished
apps are visible and usable only by administrators, even when Use access is granted.

### Studio advanced tools

Open an app's action menu and choose **Advanced**. The same menu is available
on app cards inside chat context and in the app detail, manual editor, and SQL console. **Edit** starts an
editing chat. Resource managers can also choose **Edit manually** or **SQL
console**. These views keep the Assistant navigation. Switch views through the app action
menu; no separate editor navigation replaces your chats.

The manual editor supports multiple files, adding, renaming, deleting and
choosing the entry file. Save explicitly with the button or Ctrl/Cmd+S.
Renaming rewrites parsed relative imports. Invalid syntax must be fixed before
renaming. A conflicting save keeps your draft; download it before explicitly
loading the latest source. Saving does not publish or run code.

**Start** in the adjacent preview runs the files in the editor, saved or not,
with the app's real data; **Restart** picks up the next edits. Use the file split-button to switch files and open
file actions, including downloading the current source draft. **Publish** on
the right creates a release from saved changes and is disabled until changes
are saved or when the saved revision is already published. On narrow screens,
switch between Code and Execution.

The SQL console has two views: **SQL** for SELECT queries (Ctrl/Cmd+Enter or
Start), and **Schema** for the tables and their columns. Schema loads the whole
database structure automatically; no table selection is required. Refresh
reloads it. An empty database is identified explicitly. Stop appears while an
operation is running. CSV exports contain the displayed rows and
escape spreadsheet formulas. SQL drafts stay in this browser profile per user
and resource. Opening the console does not create a database: use **Connect
database** explicitly. An unconfigured instance explains why it is unavailable.

**Personal data** shows only the signed-in viewer’s JSON keys, on every device.
No app can select another viewer’s personal data. Anonymous public-share visitors
cannot access it. Resource managers can inspect and clear **Shared data**, and
use **Manage database** to download a SQLite backup or reset the database.
Reset preserves source, publications and file/KV stores. Source restore does not
restore data. The SQL Schema view also shows each table’s write rule.

Remote administration uses the same permission-aware services through
`assistant code database-status`, `database-export`, `database-reset`,
`storage-manage`, and `storage-clear`. Shared storage requires Manage;
`scope:"user"` limits KV inspection and changes to the current viewer.
Global rsql credentials remain restricted to AI administration.

### Analyze once or reuse an App

Code Mode uses direct Assistant tools named `code_*`, loaded individually when
needed. They are not Cloud capabilities and cannot be called through
`cloud.capabilities.run`. Source operations and SQL execute on the server; script
runs use the isolated server or CLI host. Studio, tools, and CLI use the same
permission-aware resource services.

Ask for an analysis, calculation, or file conversion directly in the chat. Code
mode can run a one-off script and return findings or output files without
creating an App. All reusable programs are Apps: an HTML interface, agent
actions, or both, with optional persistence. One-off scripts stay scoped to their chat and cannot
be published or shared. Existing saved scripts are migrated to Apps without
changing their IDs, source, publications, grants, Project links or shared data.

One-off scripts can receive selected attachments from their current chat. Apps
never gain implicit access to chat attachments. A Project administrator who also
manages an App can associate it with the Project. Current members can use its
publication through Studio, the standalone runner, tools and CLI. Members gain
Use, including shared app data and copying published source, but never editing
or management rights.

Apps declare optional actions in `app.actions.json`, saved and published with
source. Each action has a unique `name`, `title`, `description`, relative handler
`entry`, `inputSchema` and `outputSchema`. The handler default-exports a function
accepting the action input, which is always a JSON object: publication rejects an
`inputSchema` without `"type": "object"`. An action published earlier with a
scalar or array input cannot be called until its App is published again with an
object schema; see
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations#code-tool-failures-are-tool-errors-and-app-action-inputs-are-objects).
An action-only App needs no `index.html`.
Publication compiles every handler without executing source. Discovery uses
static metadata.

`code_actions({id})` returns the current publication and action schemas;
`code_action({id,action,publishedVersion,input})` runs that exact publication with
Use access. `input` is the object itself, never JSON text; a value that does not
match the schema returns `ACTION_INPUT_INVALID` with each rejected field and does
not run the action. Changed publications require fresh discovery. Draft and management
rights remain separate. Runtime approvals still apply; a failed output check or
timeout does not undo effects. The CLI equivalents are `assistant code actions`
and `assistant code action --chat CHAT --input-file call.json`.

### Build apps as HTML

An app's interface is plain HTML, CSS and JavaScript: `index.html`, optional
`style.css` and `app.js`, and further JavaScript modules that `app.js` imports
with relative paths. There are no frameworks, build steps, CDNs or npm packages.
Cloud adds the document head, the viewer's language and theme, and a base
stylesheet, so headings, lists, tables, forms, buttons, `<details>` and
`<dialog>` look like Cloud in light and dark without writing CSS. The app's own
CSS always wins. The theme follows Cloud while the app runs.

Each app runs in a locked frame inside a second frame without script. It cannot
read the Cloud page, cookies or browser storage, reach the network, navigate
the page or open windows. Everything it needs goes through `cloud.*`: data,
files, AI, PDFs, HTTP through Cloud and other apps' capabilities. Natural
browser code that cannot work there fails with a clear message: `fetch`,
`alert`, `confirm`, `prompt`, `print`, `localStorage`, and inline `on…`
handlers. Forms never navigate. A link to an `https` address opens in a new tab
after the person confirms the full address; other links are ignored. Files the
app hands out, with `cloud.download` or a download link, are saved as files and
never opened on the Cloud domain. The address bar keeps the app's `#hash`, so a
reload returns to the same view.

Whenever Cloud asks the person something for an app, an HTTP request, a
capability or a link, the app is greyed out and cannot be clicked until they
answer, and the confirm button becomes active only after half a second. One
question is open at a time per app; after three refusals Cloud stops the app. An
app that floods Cloud with messages is stopped as well.

An app appears once its modules, including top-level `await`, have run, its
fonts are loaded, and no `cloud.*` call is pending, at most after a few seconds;
until then a loading state holds its place. Errors, `console` output and the
static findings of the composer appear in the app's console. A failed `cloud.*`
call that the app did not handle also shows a notice outside the app.

`code_write` reports static problems in an app's JavaScript and CSS, and
`code_present` refuses an app with errors such as CDN scripts, missing imports
or inline handlers. Apps do not run in `code_run`; a rendered self-check of an
app is not available yet.

### Store data and combine Cloud actions

Code Mode exposes one frozen global `cloud` in HTML apps, scripts, app actions,
Studio, CLI, and scheduled hosts. The code-mode skill includes the self-contained
`cloud.md` contract reference.

Choose storage by who owns the data: `cloud.kv.user` for personal preferences
and todos across devices, `cloud.kv` for small shared app settings, `cloud.db`
for records several people add or edit, and `cloud.files` for shared files.
Each KV scope allows 1,000 keys, 1 MiB per value, and 16 MiB in total. Keys are
sorted and paged with `after` and `limit` (default 100, maximum 1,000). Personal data is isolated
by app and signed-in user; anonymous visitors receive `denied`.

Runtime file writes accept Blob or string, at most 16 MiB. File reads return
File or null. Operator settings still bound shared file storage and binary CLI
transfers; lowering a quota preserves existing data. Browser-local storage,
OPFS, personal file storage, and runtime file-picker methods are removed; an
app reads a person's files with `<input type="file">`.

Schema belongs to the Manage-only `code_database` tools. Table creation connects
the database when needed; the operator must configure rsql. Runtime code uses
the flat `cloud.db.list/get/insert/update/delete/query` API. Lists return arrays,
plain filters mean equality, and null means IS NULL. More than 1,000 matches
without a limit raise `limit` and explain `limit`/`offset` paging. Missing rows
return null from get/update and false from delete. Boolean and JSON columns
retain their types; inserts return rows with generated ids.

Cloud manages `id`, timestamps, and nullable `created_by`/`updated_by` user ids.
The server takes audit ids from trusted identity and rejects client values.
Each table has a durable `write` rule: everyone (default), own (only creators
update/delete), or managers (Manage required for all writes). Anonymous viewers
cannot write. Existing tables gain nullable audit columns on first runtime
access without backfill. SELECT queries use positional `?` parameters;
`code_sql` and the SQL console allow direct authorized inspection.

`cloud.capabilities.run` and `cloud.capabilities.streams` call discovered Cloud
operations with current permissions and approvals. Code cannot approve itself.
All server writes remain real in tests and survive source restoration.

### Run code from the CLI

`cld assistant code run --chat CHAT --input-file run.json` uses an isolated
headless Chromium host without requiring a model turn or an open browser tab.
The input contains either a saved resource `id` or a one-off `code` entry.
Optional `inputPaths` select chat files for scripts; an admin can select a
published `version` for a saved resource.

Use `--steps-file` for subsequent inspect, interaction, or file-export steps in
the same run. The host waits for background work to finish before the command ends; a pending
app dialog needs an explicit interaction step. The host closes when the command ends and cancels pending server requests.
Exported files remain in the chat. If the host exits unexpectedly, pending calls
fail without automatically repeating code or actions. Capability actions need explicit `--approve` authorization or the
interactive chat approval flow. The CLI needs Chromium installed through
Playwright, or `CLOUD_CLI_CHROMIUM` pointing to an installed Chromium executable.
If the host does not start within 45 seconds, the command fails without running
code and names the startup step that stalled, such as launching Chromium.

### Administer Studio

The Assistant administration page lists all saved Apps, their shared
file and key/value counts, and whether they have a database. Administrators can
manage access, delete resources, and configure or test the rsql connection.
The stored API token is never returned. Removing or changing the server is
blocked while databases or queued database cleanup still depend on it.

Deleting a resource removes its source, publications, grants, shared data and
personal JSON; remote database deletion is queued for cleanup. The same management operations are available
under `cld assistant studio-admin`.

### Process input documents

A script default-exports `(input, {files,signal,progress}) => Json | void`.
`files` contains the selected chat inputs as `{path,size,type,file()}`; content
loads on demand. App actions receive an empty array. Stop aborts the signal.
Progress is available only while the entry function runs. Reports renew the 15-second responsive-work watchdog; time-limit
errors name the limit and suggest splitting work, reporting progress, or using
a scheduled action. Completed writes are not rolled back.

`cloud.sheet` detects CSV delimiters and UTF-8/Windows-1252 encoding. Numeric
columns become numbers in their source convention, including currency values;
leading-zero codes and dates stay text. Ambiguous numeric columns use unambiguous number columns in the same file, then the export convention: dot decimals with a comma delimiter, otherwise the locale’s decimal mark. Columns containing unsafe integers stay text. Duplicate or blank header collisions get unique suffixes; malformed CSV and rows beyond the header fail with `invalid` and a line number.
`numbers:false` disables conversion.
`toCsv` is asynchronous and emits semicolon, BOM, CRLF, formula-escaped cells,
and the same decimal convention. Await it before `cloud.download(name,data)`; passing
a Promise raises `invalid` with guidance. XLSX/ODS are detected from bytes;
`rows()` defaults to the first sheet and includes headers. `toOds` exports ODS.

CSV, spreadsheet readers, finance formats, and the PDF.js reader load on first
use from separate content-hashed bundles through the host bridge. The worker
never fetches them from the network. PDF reading uses `cloud.pdf.read`, then
`page(number)` and `close()`. Document budgets remain 64 MiB input and 128 MiB
expanded workbook XML. There is no OCR, formula execution, or XLS/XLSB reader.

Selected inputs and captured downloads retain the 50 MiB-per-file,
250 MiB-total, 64-file run budget. Input reads and approval waits pause startup
watchdogs. A tool call still has a 45-second outer budget including compilation
and transfers; capability approval waits pause that budget. Each failed cloud
call uses `CloudError` with a stable code: denied, not_found, invalid, conflict,
limit, unavailable, or cancelled. Unhandled failures remain visible in
diagnostics.

Source history reclaims oldest unpublished revisions when its 250 MiB budget
fills. Current source and published versions remain protected. If these alone
fill the budget, saves fail atomically; a separate copy starts fresh but does not
copy data or grants. Active runtime calls renew their execution ownership, so a
long human approval does not make a second tab report a fixed-time interruption.
An expired host is never replaced by automatic replay of an uncertain action.

Finished one-off runs without UI, exports, pending requests, or running jobs are
reclaimed automatically when the host reaches its 32-run limit. Saved resources
and retained runs require explicit stopping. Snapshot output previews are capped
at 16,000 characters and include `outputTruncated`; use file export for complete
results. Invalid tool arguments are rejected as a tool error before source
execution.

### Consent and resource cleanup

When you run an App you do not manage, every Cloud capability call
asks for consent, including reads. The dialog identifies the resource and warns
that returned data can be stored in shared files or its database. Personal
remembered approvals are not reused or created for these calls. Denial prevents
execution; existing access and action-review checks still apply.

Resource managers can permanently delete an App from its Studio menu
or with `cld assistant code delete ID --yes`. Publications, grants and shared
and personal JSON storage are removed; database cleanup is queued and retried. Platform administrators retain the administration
surface for operator cleanup.

Chat starters prepare editable prompts for file analysis, app creation,
capability discovery and mail follow-up. Code starters attach the readable,
enabled Code Mode skill as a removable chip; unavailable skills leave a text
prompt. Existing draft text and attachments remain intact. No tools or extra
permissions are granted by choosing a starter.

CSV reads accept an explicit `encoding`, such as `windows-1252` for older Excel
exports. Invalid UTF-8 fails with a decoding error instead of corrupting names.
Database and shared-storage requests pause the short execution/readiness timers
but remain subject to the outer tool budget. Exported files use readable names
under `/files`; collisions receive a suffix and the tool returns the actual
stored path. Pending code approvals remain visible when switching chats.

### Finance exports and app maintenance scripts

Code Mode bundles pure-JavaScript DATEV CSV and SEPA SCT XML generation through
`cloud.finance.datev.validate/serialize` and `cloud.finance.sepa.validate/serialize`. Export bytes through the
normal file workflow. No WASM/XSD validator is included. Input validation does
not guarantee bank acceptance; creating an export never submits a payment.

Use `code_run({code, resourceId})` to inspect, import, migrate or export an existing
app's database and shared files/KV without editing its source. This requires
Manage access, checked on every remote data operation. Personal KV is server-side; chat files require explicit inputPaths. Source restoration does
not undo database or storage changes. The CLI accepts the same run input.

### Call external APIs with personal secrets

Code Mode supports server-side `cloud.http.fetch()` with `cloud.http.secret()` references in
headers. The server injects the saved value after checking the current user's
access and the secret's exact HTTPS origin, header and prefix. The worker and
chat receive references, not saved values. Public requests work without a
secret. Every request asks for confirmation and can affect real external data.

Ask Assistant to configure a secret through `code_secret`. A trusted dialog
collects the value directly; the chat receives only a confirmation. Never paste
keys into chat or generated app controls. In Studio, use **Advanced → Secrets**
to add, replace or delete your personal secrets for that app. Chat secrets are
available through the workspace context menu. Values are not shown again.

Secrets belong to the current user and one chat or resource. Shared apps use
each user's own credentials. Publications keep the same personal secrets;
copies do not inherit them. One-off code bound to a resource uses that resource's
secrets. There is no fallback across contexts. HTTP is unavailable in chats
with a restricted tool scope.

```js
const response = await cloud.http.fetch("https://api.example.com/customers", {
  headers: { Authorization: cloud.http.secret("crm", { prefix: "Bearer " }) },
});
if (!response.ok) throw new Error(`API returned HTTP ${response.status}`);
const customers = await response.json();
```

The first version supports public HTTPS, header authentication and bodies up
to 4 MiB in each direction. Redirects, cookies, internal network access and
streaming are unavailable. Each external request has a 20-second deadline;
confirmation time does not count. HTTP failures still expose their status and
body. Network failures can leave the external outcome unknown: inspect the
service before deliberately retrying. Stopping a run cannot undo completed
external actions.

Before returning an HTTP response, Cloud redacts every inserted secret value, its full prefixed header value, base64/base64url, JSON-escaped (including escaped slashes and ASCII Unicode escapes), and URL-encoded forms from headers and body bytes. When at least one occurrence is replaced, the response carries `x-cloud-redacted: secret` and its content-length header is removed. Other returned content remains untrusted.

The CLI uses the same execution path and prompts for HTTP confirmation in
interactive mode. Unattended runs can authorize an exact origin with
`--approve http.fetch:https://api.example.com`. Configure secrets in the web UI
for the same user and chat or app before using the CLI.

## Explore data with Code Mode

Assistant computes with scripts and shows the result as an HTML app: key
figures, tables and charts from `cloud.chart`, which draws in Cloud colors and
redraws at the real width, so axes fit phones. Filters, tabs and forms are
ordinary HTML controls. The `assistant-data-analysis` Skill guides source
inspection, metric definitions, reconciliation, chart choice, and delivery. The
API is available without loading the Skill. An app states when its data was
retrieved and whether it is a snapshot, partial, or a fixture. A live loader is
explicit; publishing source does not create a frozen data snapshot or a
continuously refreshing dashboard.

Shared access and published source versions use the normal Studio lifecycle.
Personal secrets remain personal. External loads still follow HTTP approval and
uncertain-outcome rules. The Code Mode references for HTML apps and charts
contain complete examples.


### Generate PDFs and read financial formats

A PDF from a chat file needs no code: Assistant converts Markdown with
`markdown_to_pdf`, and HTML with its CSS, header, footer, images, and fonts
with `html_to_pdf`. Studio Apps and one-off scripts can generate PDFs with `cloud.pdf.render({ html, ... })`,
embed files with `cloud.pdf.attach({ document, attachments })`, and combine invoice
HTML and XML with `cloud.pdf.render({ html, facturX: { xml, profile }, ... })`. Each returns a Blob
for download or explicit storage. HTML contains its own CSS; local images,
fonts and stylesheets can be passed as named assets. External resources and
scripts are blocked. Paper format, orientation, millimeter margins, optional
headers/footers and PDF tagging are configurable. These methods need Gotenberg;
local PDF text extraction continues to work without it.

Use access suffices for published apps. Gotenberg credentials remain on the
server. Requests can be cancelled, are bounded by configured Gotenberg limits
and a 64 MiB transfer ceiling, and store no result automatically. A PDF/A-3b
with XML and Factur-X metadata is not a certificate of invoice validity.

Studio supplies `cloud.money` and lazy `cloud.finance.camt`, `einvoice`, `datev`
and `sepa` methods; finance calls are awaited. Read camt.052.001.08 reports, calculate exact invoice totals,
generate supported ZUGFeRD CII EN16931 XML, including zero-rated, exempt,
reverse-charge, intra-EU, export and out-of-scope VAT, or read invoice XML
directly or from PDF attachments. Generation covers invoices, credit notes,
self-billing and self-billed credit notes, with an optional delivery date or
invoicing period and optional payment by transfer, cash, online service or
clearing. An incoming read mode also accepts received
CII XRechnung invoices with discounts and prepayments and lists unmapped
fields. PDF invoice reading extracts embedded XML; it is not OCR.
No WASM/XSD checker is included. Parsers preserve declared incoming values;
the app still owns reconciliation, numbering and manual decisions.

For example, an app can read a bank report and invoice attachments, suggest
matches for review, and save a report with its XML data attached. A separate
invoice app can calculate totals, generate XML, render matching HTML and offer
the resulting PDF for download. Neither flow submits payments automatically.
The Code Mode skill contains complete PDF options and Finance API references.

### Agent data administration

Assistant loads management tools only for a requested maintenance task. Manage
access is required; ordinary published App actions continue to work with Use.
The documented Studio API is the complete agent contract, independent of the
software implementing its database service.

- `code_storage_list` reads paginated shared file/JSON-key metadata and the
  current storage revision. `code_storage_delete` deletes an exact key or clears
  files, JSON storage, or both after fresh review. Concurrent writes invalidate
  the review. Source and database are preserved.
- `code_database_read` reads connection state and opaque database revisions.
  `code_database_export` writes a bounded backup to a new current-chat path;
  existing files are never overwritten.
- `code_database_clear` clears rows while retaining tables and schema. It reports
  completed tables and any partial failure explicitly. The CLI equivalent is
  `assistant code database-clear ID --yes`.
- `code_database_reset` discards schema and data after fresh review. Source,
  publications, and shared files/JSON keys stay intact. Physical cleanup is
  queued; the next connection starts with an empty database.
- `code_manage_read` obtains the snapshot required by `code_delete`. Deletion
  removes the entire App and its server data after fresh review. Source,
  publication, storage, permission, or database changes invalidate that snapshot.

Database write attempts invalidate earlier reviews even after an uncertain
upstream outcome. Neither cancellation nor restoring source undoes data writes.
The agent must inspect partial or unknown outcomes before requesting a retry.

### Transfer files between stores

`code_files` lists files in one authorized chat, Project, or App. Its entries
contain explicit `{scope,id,path}` locations. `code_file_stat` adds an opaque
string version to form a reference. `code_file_copy` copies that exact source
reference to a destination location; `expectedVersion:null` requires a new
path, while an existing destination requires its reviewed version.

The agent shows source, destination, and overwrite scope for fresh confirmation.
App and Project destinations can disclose a private attachment to other
recipients, so no whole-chat mount or implicit attachment transfer is involved.
App files require Use, Project writes require Write, and chat files require
ownership. The receiving store enforces its ordinary byte budgets. Bytes never
pass through a model response. Concurrent changes reject the copy rather than
overwrite newer data.

Use `assistant code files`, `assistant code file-stat`, and
`assistant code file-copy --yes` with JSON input files for the same CLI flow.
`code_write` also accepts `{path,fromFile:reference}` for reviewed UTF-8 source
imports. This replaces the former chat-only `fromChatFile` input. Imported data
becomes source and can be published; ordinary runtime data belongs in shared
files or the database instead.

### Reusable action examples

The repository includes four complete source bundles in
[`packages/assistant/examples/studio-actions`](https://github.com/k2b-dev/cloud/tree/main/packages/assistant/examples/studio-actions):
a stateless CSV converter, an agent-only shared-record importer, a display-only
dashboard with a separate maintenance action, and an invoice-linking App. Their
README covers setup, publication, file transfer, repeated use, conflict handling,
and a linked Skill with independently managed permissions. The integration
suite runs their published handlers in the isolated Studio runtime.

### Agent management coverage

| Existing Studio operation | Agent path |
| --- | --- |
| Find Apps, inspect source and revisions | `code_list`, `code_read`, `code_history` |
| Change working title, description or icon; make a private copy | `code_update`, `code_fork` |
| Create, edit or remove source files | `code_create`, `code_write`, `code_remove` |
| Run scripts and actions, inspect, export results or stop | `code_run`, `code_action`, `code_inspect`, `code_export`, `code_stop` |
| Open an app, show it in chat, publish, withdraw or restore a publication | `code_open`, `code_present`, `code_publish`, `code_unpublish`, `code_restore` |
| Read and change grants | `code_access_read`, reviewed `code_access_change` |
| Inspect/copy chat, Project or App files | `code_files`, `code_file_stat`, reviewed `code_file_copy` |
| Read/write shared JSON or files | Documented runtime storage APIs in a Manage-authorized maintenance run |
| Delete entries or clear shared file/JSON storage | Reviewed `code_storage_delete` |
| Inspect database/schema, read or mutate structured records | `code_database_read`, `code_sql`, documented runtime database APIs |
| Export database, clear rows, discard schema and data | `code_database_export`, reviewed `code_database_clear` and `code_database_reset` |
| Delete App and queue external database cleanup | Reviewed `code_delete` |

Personal JSON is stored on the server, visible only to its owner, and deleted with the App. Personal secret values stay in the trusted `code_secret` dialog; listing
or deleting another person's credentials is not an App management operation.
Project associations are managed from the **Studio Apps** section of a Project or the CLI
(`assistant code projects` and `assistant code project-link`). Linking or unlinking requires
Manage access to both the app and Project. The app picker only lists apps you
manage; linked drafts are unavailable to members until published. Project links
grant current members Use in Studio and the standalone runner as well as tools
and CLI, without editing rights. They persist independently of their creator's
later permissions. They are not a general vendor API. Operator connection settings and secrets remain installation
administration; normal App workflows do not load or expose them. There is no
arbitrary vendor-admin SQL interface. Every path retains the owning service's
current authorization and version checks.

### Agent error recovery

A server-run code call (every runtime tool except `code_open` and `code_secret`)
that does not complete (rejected arguments or action input, a timeout, an
unavailable run, a lost host) reaches the agent as a tool error with its reason
and next step, and the chat shows the step as failed. A `code_present` call with
static errors is a tool error that lists them; nothing is saved. A `code_run` or
`code_action` whose code fails still completes the call;
its snapshot reports `status: "error"`. `code_open` and `code_secret` run in the
user's client, which cannot mark a tool error: a failed `code_open` returns
`{failed: true, error}` as its result, and a failed `code_secret` surfaces as an
output validation error.
Invalid App manifests or handler code return `COMPILE_FAILED` with source
diagnostics. File collisions return `CONFLICT`; file/storage byte limits return
`STORAGE_FULL`. These known rejections do not imply an uncertain write. Access
reviews show the recipient name, principal type and identifier. Published Action
discovery returns `publishedVersion`; only draft discovery returns a working
`revision`. Database clear keeps concurrent writes/resets excluded and shares a
15-second database budget across all tables; inspect partial results before retrying.
Single-table deletion is supported by the Manage-only structured CLI operation
`tables.delete`, not by the runtime JavaScript database handle or an agent tool.

## Actions in Cloud search

Use **New chat** in Cloud search to start a conversation without sending a message. Within a project, the context action creates a chat in that project. The current chat exposes message search and marking the chat done or reopening it when no response is active.

Available keyboard shortcuts appear next to actions and in Layout Help.

### Search chats from the global palette

**Search all chats** searches titles and message content in your non-archived chats.
**Search this chat** searches messages in the currently open chat. Both use the
global search with a removable context chip. Choosing either action inside the
palette changes that context in place and keeps the input focused. Remove the
chip to search across Cloud again.

Chat results open the conversation; message results reveal the matching part of
the timeline, loading older history when needed. Cmd/Ctrl+Enter opens the same
message link in a new tab. Chats remain private to their owner, including when
they belong to a shared Project. Search results do not advertise a resource reader.

Cmd/Ctrl+Shift+K searches the open chat, falling back to all chats outside a chat. Cmd/Ctrl+Alt+N creates a chat in the current project; D toggles done when the chat is idle and focus is outside an input. Search actions update the open palette in place. Actions for the selected object appear before page actions.

### Apps in chat

`code_present` shows an HTML app as a card in the conversation. It takes either
one-off files, which are stored with the chat and have no database, `cloud.kv`
or `cloud.files`, or a saved Studio app, which the card runs with its current
source and data under the viewer's access. Presenting creates no Studio App and
no chat file. Before anything is saved, the call checks the files and refuses
static errors.

The card shows the app's title, **Studio app**, and its actions. It keeps a
fixed height, 45% of the viewport and at most 600 pixels, from the moment the
call starts, so nothing in the chat moves. An app in the chat starts only when
the person selects **Start**, never while scrolling past; **Stop** and leaving
the chat end it, and the card keeps its place through the end of the turn. A
saved app also offers **Open**, which shows it beside the chat.

While the app runs, the download menu saves a static copy as it is shown, as
**HTML** or **PDF**. The copy keeps text and styles but no scripts, event
handlers, frames or script links, and it is saved as a file, never opened on the
Cloud domain. These downloads need no chat-file entry. Presentations of a chat
share a 250 MiB storage budget.

### AI inside Code Mode

Scripts, apps in chat and authenticated Studio apps can use
`cloud.ai.text`, `cloud.ai.classify` (including multiple choices), and `cloud.ai.extract`.
These server-backed calculations return ordinary values and do not load chat
history, files, memories or tools automatically. Supply the intended input.
The executing user's model access and personal chat allowance apply, including
when running a shared app or testing code. Public and local-only runners cannot
use these methods. Stopping a run cancels pending inference. The Code Mode skill's
AI reference documents options, limits and examples.
