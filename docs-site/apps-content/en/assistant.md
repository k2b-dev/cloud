---
title: Assistant
navTitle: Assistant
section: Work
order: 100
description: A personal AI workspace for conversations, files, Projects, and reusable preferences.
tags: [assistant, ai, chats]
updated: 2026-10-19
---

# Assistant

## Work with a local folder in cld

Start `cld ai` in the folder you want to work with: Assistant can list, read,
upload, and create ordinary files there freely. Use `/permissions off` to stop
local tools; Enter means No at approval questions. AGENTS.md and project Skills
load after you trust the folder; `/skills` lists local and Cloud Skills, and
`/<skill>` selects one for your next message. Local results and uploaded files
go to this Cloud chat and can be sent to the model.

cld asks before:

- Running a Bash command.
- Appending, replacing, or moving files.
- Accessing protected files or files outside the start folder.
- Every file access when started in your home folder or above.

## Use Assistant in an editor

Run `cld acp` to use Assistant in editors such as T3 Code and Zed with your
Cloud login and the editor's project folder. Chats stay in Cloud and can
continue on the web. Sending, deleting, sharing, and inviting wait for your
confirmation in Cloud; the editor shows the chat link. See
[Assistant in editors](/en/docs/ai/editors) for installation and setup.

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
own frame. The background at its scroll edges follows Cloud's light or dark
appearance, including changes while the app runs. Restarting shows progress in
the button without adding a status row
or moving the app. This distinction uses app permissions, not the global Cloud
administrator role.

An app starts on its own only for people who manage it. Everyone else sees the
app's name and **Start**, so code someone else wrote never runs just because a
page opened. If an app's last start in this browser tab never finished, for
example because of an endless loop, it does not start on its own again; the page
explains this and offers **Start**. Leaving or reloading the page during a start
counts as unfinished too, so a reload during a slow start asks once.

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
- Choose **+** to open the same list as `/`, with a search field on top.
  **Attach file** takes files from this device or, when Cloud apps offer files,
  a copy from one of them, such as Files. **Insert from Cloud** inserts a
  reference at the text caret; the model receives the same resource as an
  attachment. **Search this chat** searches messages in the open chat.
  Escape, **+** again, Back on a phone, or an outside press closes the list.
  An outside press only closes it and does not activate the control underneath.
  Files and screenshots can also be dropped or pasted directly into the composer. A long plain-text paste becomes a durable **Pasted text** attachment;
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

The sidebar shows one chat list of plain rows: pinned chats first under
**Pinned**, then the other active chats under **Today**, **Yesterday**,
**Previous 7 days**, **Previous 30 days**, and **Older**, by when you last used
them in your own time zone. Each row shows only the chat's title. One quiet
icon at the row's end marks a chat that is running, waiting for you, failed,
has a new response, or has an active schedule; its tooltip names the state.
**Done** remains a separate collapsible section. The phone menu lists the same
sections. There the icon keeps a fixed place at the row's end even while a chat
is quiet, so a long title wraps the same way and a status change never moves
the rows below.

**Projects**, between Studio and Personalize in the footer, opens the same preview popup as chat rows: hover or click it to choose a Project, create one with **+**, or open global search with the **Search Projects** button. The search shows one **Projects** context chip and matches accessible Project names and descriptions. Removing that chip returns to global search.

Inside a Project, **Search chats** opens global search with the Project name as
a context chip. Results are limited to your chats in that Project.

The main sidebar search button has a different purpose: while a Project is open, it searches your own chats within that Project using a removable Project context.

On mobile, expand **Projects** to reach the same destinations and actions. Project chats remain in the main chat list; the chat preview names the Project. **Done** includes the **All chats** entry.

Choose **Mark chat done** on a sidebar row when its work is finished. Stop a
running response first. Done chats move into the collapsed **Done** section;
their files, apps, history and pinning remain available. Choose **Reopen chat**
to bring one back, or send a new message to continue it. A finished response
does not automatically mark the whole chat done.

Hover over a chat for its description, Project, last model, apps, files and
**Chat settings**. Touch devices provide an information button; keyboard users
can reach the same preview with Tab. Resource details load when the preview
opens. **All chats** inside **Done** searches your chats and filters them with
one menu: all chats, new responses, running, waiting for you, failed, done, or
archived. Each row shows the time its list is ordered by: when the chat last
changed, or, under **Done**, when you last used it.

The CLI supports `cld assistant chats done CHAT`, `chats reopen CHAT`, and
`chats list --lifecycle active|done|all`. Archiving remains a separate action.

Pinned chats always remain active, overriding explicit or automatic completion. Unpinning reveals the underlying completion choice again. The sidebar hides the Done action for pinned chats; pinning and unpinning are available directly in the chat preview.

Chat selection responds immediately while details load. Previously opened chats reuse their cached content while refreshing; switching does not wait behind a page transition.

Titles that do not fit end with an ellipsis. **New chat** keeps you in the
current chat when it is still empty, so unused chats do not pile up. It creates
a new chat instead when the open one belongs to a Project, was opened by another
app with `launchAssistant`, carries a name or description you gave it, or is
pinned, done, archived, or no longer available. The sidebar button, the command
palette, `/new`, and the keyboard shortcut behave the same. A new chat is named
"New chat" in your language until its first message names it.

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
references. **Add files** and **Add images** take files from this device or,
when Cloud apps offer files, copies from one of them, such as Files; files
dropped on the Project context are added too. Project administrators manage instructions, the default model and
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
the current branch. **Continue in a new chat** on an answer copies the
conversation through that answer into a new chat, so another direction does not
replace the existing one. **Response details** lists the model, time, and token
usage of one answer.

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
**Always approve**. The browser no longer offers that choice; earlier choices
still apply until the next major release. Revoking an entry makes Assistant ask again on the next
matching call. Sending email, deleting data, open-world effects, and other
Actions with the default approval policy continue to require confirmation every
time. Code Mode source and execution tools run without confirmation within the
user's existing permissions; they do not implicitly grant sharing or app deletion.

Approval questions show a sentence with chips, Cloud's reason, a preview, and
two answers naming the deed and target. Where allowed, **Yes, and don't ask
again in this chat** remembers the reviewed scope for that chat. The card keeps
its review after reload. If an outcome is unknown, **Check again** runs only
the app's outcome check, never the Action; it is available after a pending or
failed check. Without a check, no repeat button is offered.

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

Interactive `cld assistant` offers local tools by default in `ask` mode.
Use `--no-bash` or `/permissions off` to stop offering them; `--allow-bash`
selects `ask` for this session even when the profile default is `off`.
`/permissions` can save the profile default: only `off` is stored, and saving
`ask` removes it. Every local Bash command is shown and needs a fresh `y`;
Enter denies. Bash runs as your OS user in the start folder without `CLD_*`
environment variables. Other variables stay available. Commands and output go
to this chat and the model. The web app shows the history but cannot run Bash.
Local Bash is never approved non-interactively and is never remembered.

Cloud approvals use numbered **Approve once**, **Approve for this chat**, and
**Always approve** choices where allowed; Enter rejects. When only one-time
approval is possible, `Approve? [y/N]` accepts `y` or `yes` and rejects Enter,
`n`, or `no`. Typed-ahead or pasted input never answers an approval. Websites
cannot be remembered from cld. Use `/approvals` or `cld assistant approvals
list|revoke` to review and revoke remembered Cloud approvals, including
websites saved in the web. `list --chat <chat-id>` lists only that chat's
approvals. Print mode never creates a remembered approval.

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

### Studio retirement

Studio apps and app data are removed without transfer. Chat scripts, files,
secrets, approvals and native views remain. Use lasting Code for a new program;
there is no automatic conversion. Operators must follow
[Studio retirement](/en/docs/operations/studio-retirement) before upgrading.

## Explore data with Code Mode

Assistant computes with scripts and shows the result as an HTML app: key
figures, tables and charts from `cloud.chart`, which draws in Cloud colors and
redraws at the real width, so axes fit phones. Hover, focus or tap a chart value
to see it. When you print an app or download its PDF, each chart is followed by
a table of its values. Filters, tabs and forms are ordinary HTML controls. The
`assistant-data-analysis` Skill guides source inspection, metric definitions,
reconciliation, chart choice, and delivery. The API is available without
loading the Skill. An app states when its data was retrieved and whether it is
a snapshot, partial, or a fixture. A live loader is explicit; publishing source
does not create a frozen data snapshot or a continuously refreshing dashboard.

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

### AI inside Code Mode

Scripts, apps in chat and authenticated Studio apps can use
`cloud.ai.text`, `cloud.ai.classify` (including multiple choices), and `cloud.ai.extract`.
These server-backed calculations return ordinary values and do not load chat
history, files, memories or tools automatically. Supply the intended input.
The executing user's model access and personal chat allowance apply, including
when running a shared app or testing code. There is no separate AI budget per
app and person: a shared app spends the allowance of the person running it, and
at most 32 `cloud.*` calls of one running app are pending at once. Public and local-only runners cannot
use these methods. Stopping a run cancels pending inference. The Code Mode skill's
AI reference documents options, limits and examples.

## Image upload privacy

New JPEG, PNG, and WebP image uploads remove location and device metadata
without changing image quality. JPEG orientation, colour profiles,
transparency, and supported animation data remain. Malformed containers are
rejected with HTTP 422. This applies to conversation uploads, Project files,
and shared App files, including images the assistant writes there, such as
fetched web images. A file counts as an image by its media type or its path
extension.

Files keeps originals. HEIC, AVIF, TIFF, SVG, video, GIF, BMP, and unknown
formats remain unchanged and can retain metadata. Previously uploaded images
are not rewritten. See [Image upload privacy](/en/docs/platform/image-upload-privacy)
for the supported formats and limits.
