# How the Assistant works

Read this before you set up Projects, knowledge, references, Skills, memories,
or scheduled tasks for someone. It explains what the Assistant can see, what it
may change, and in whose name. The [Assistant CLI](index.md) reference holds the
full command syntax.

In short:

- The Assistant always acts as the person who is chatting, with that person's
  current Cloud permissions. It never gets more access than they have.
- A Project reference is a pointer that the Assistant reads live, with the
  reader's own access. It grants nothing. Project knowledge and files are
  copies, and every Project member can read them. Linking a Skill or Studio App
  to a Project is the one exception that grants access: members can use it.
- App reads never ask for approval. Changes to app data ask first, unless the
  app marks the Action as safe without approval.
- Scheduled tasks can use only the capabilities granted to the task. Nothing
  can be approved while a task runs in the background.
- Your own direct `cld` calls are not Assistant turns. They run with your CLI
  profile's identity and skip the Assistant's approval prompts, so ask the user
  before you change their data.

## What the Assistant is

The Assistant is each user's personal Cloud agent. Every chat belongs to one
user. Chats in a Project stay private to the person who started them. The agent
runs in Cloud, not on your machine; local shell access exists only in an
interactive `cld assistant --allow-bash` session.

It works with two kinds of tools:

- **Built-in tools:** chat files, document reading, web search and import, PDF
  creation, Code Mode, Studio Apps, memories, Skills, and the current Project's
  knowledge and files.
- **App capabilities:** typed Queries (reads) and Actions (changes) that each
  installed app publishes. The Assistant finds and loads them while it works,
  so a new app is usable without any Assistant setup. List them with
  `cld capabilities catalog --json`.

## Whose permissions it uses

Every app capability call runs as the chat's owner. Cloud resolves that user
again for each turn and the owning app checks current access on every call.
Revoked access takes effect on the next call. Turns started from the Cloud
mobile app run without the administrator role.

An agent account signed in with client credentials cannot chat with the
Assistant, because chats need a person. A service account can still create a
Project and becomes its `admin`. Grant the person `admin` with
`projects access grant "<project>" <user-id> --type user --permission admin`.
A Project always keeps at least one `admin`, so the service account can then
remove its own entry with `projects access revoke`.

For a shared Project this means:

| Situation | Result |
| --- | --- |
| A member can read the referenced note | The Assistant reads the current note in that member's chats |
| A member cannot read the referenced note | The read fails in that member's chats; nothing is exposed |
| A member has Project `read` access | They can read the Project's instructions, knowledge, and files, and the Assistant uses them in their chats |
| A Skill or published Studio App is linked to the Project | Members can read and use it while they belong to the Project |
| A member loses Project access | New turns in their Project chats fail until access returns |

Adding a reference to a Project grants no access to the resource. Share the
resource itself in its app.

## What a Project shares

| Kind | Command | Stored as | What the Assistant reads | Limit |
| --- | --- | --- | --- | --- |
| Instructions | `projects create` or `projects update --instructions-file` | Text in the Project | The current instructions at the start of every turn | 16,000 characters |
| Knowledge | `projects knowledge add --content-file` | A copy of the text | The stored copy; it never follows the original | 100,000 characters per entry |
| Files | `projects files put` | A copy of the bytes | Read-only files below `/project` | 10 MiB per file |
| Cloud references | `projects references add` | Type, ID, and label | The live resource at read time, with the reader's own access | First 500 are used |
| Skills | `projects skills link` | A link that gives members Read and Use | Its current instructions, loaded when relevant | Skill limits |
| Studio Apps | `code project-link` | A link that gives members Use | The latest publication | App limits |

Each turn starts from the Project's current revision: its instructions, the
knowledge and file lists, and the reference list. A retry reuses the revision
of its original turn. Permissions are never part of that snapshot; every read
and call checks current access. Instructions are the only instructions in a
Project. The Assistant treats knowledge, files, references, and tool results
as data, never as instructions.

Changing instructions, the default model, or Project access needs Project
`admin`. Knowledge, files, and references need `write`.

**Knowledge or reference?** Link a reference for anything that lives in an
app and changes: a note, a notebook, a Space, a base, or a mailbox. It stays
current and respects each member's access. Use knowledge only for stable text
that every Project member may see. A pasted note does not update, and members
can read it even if they cannot open the original.

## Give it a notebook, Space, base, or mailbox

The Assistant can already use every resource the person can access, in any
chat. A reference makes a resource the obvious context for a Project and shows
its type, ID, and label to the Assistant on every turn. It grants nothing.

1. Share the resource in its app with every person who should use it. The
   Assistant cannot reach what the member cannot open.
2. Find the resource ID through the app's commands or through
   `cld capabilities query <app> <query-id> --input '{...}' --json`, which
   returns `refs`. Confirm that it resolves with
   `cld capabilities read <type> <id> --json`.
3. Add the reference:
   `cld assistant projects references add "<project>" <type> <id> --label "<label>"`.
4. Optionally add a routing rule to the Project instructions, such as "Create
   tasks for this Project in the Space labeled Roadmap."

When the Assistant opens a reference, it runs the type's reader Query and gets
what `cld capabilities read <type> <id> --json` shows you. For a note, that is
its current Markdown. For a container such as a notebook, base, or mailbox, it
is the container's details; the Assistant then uses the app's other Queries to
list and read what is inside.

Common reference types:

| Resource | Type |
| --- | --- |
| Notebook or note | `notebooks.notebook`, `notebooks.note` |
| Space or Space item (task, event) | `spaces.space`, `spaces.item` |
| Grids base, table, view, or record | `grids.base`, `grids.table`, `grids.view`, `grids.record` |
| Mailbox or mail conversation | `mail.mailbox`, `mail.conversation` |
| File or folder | `filesv2.entry` |
| Address book or contact | `contacts.book`, `contacts.contact` |
| Pulse base or saved query | `pulse.base`, `pulse.saved_query` |

The live list is every `manifest.types` entry with a `reader` in
`cld capabilities catalog --json`. Cloud rejects a type that does not exist or
has no reader with "Cloud resource type is unknown or has no reader." Link
Skills with `projects skills link`, not as a reference.

## What it can create or change, and in whose name

The Assistant can run any Action an installed app publishes, within the user's
rights. Examples are creating Spaces tasks, editing notes, drafting or sending
mail, updating Grids records, creating Skills, and scheduling chat tasks. It
can also change who may use a Skill or Studio App the user manages, after a
fresh review. Check `cld capabilities catalog --json` for the current set.

Changes happen in the user's name. The app records the user as the author or
actor, as it would for a change in its own UI. Cloud also logs each capability
call with origin `assistant` and the user. Operators see this log in Gateway
Ops observability; no `cld` command reads it. The chat keeps the tool call and
its result; `cld assistant messages list <chat-id> --json` returns them. Declined
approvals are logged as `rejected`. Your direct `cld capabilities` calls are
logged with origin `http` under your CLI profile's identity.

Without any approval, the built-in tools change only the chat's own files and
the user's memories.

## Approvals

The owning app decides in its capability manifest whether an Action asks
first. Users and administrators cannot loosen that policy for the Assistant.
It applies only to Assistant turns: a direct `cld capabilities action` call is
an explicit invocation and never asks.

| Operation | Approval |
| --- | --- |
| Query, such as search or read | Never |
| Action with `approval: "none"` | Never |
| Action with `approval: "rememberable"` | Asks; the user may choose **Always approve** for the app's scope |
| Action without an `approval` field | Asks for every call; cannot be remembered or granted to a scheduled task |
| Built-in tools on chat files, memories, web search, PDFs, and Code Mode | Never; capability calls inside Code Mode still ask |
| Studio App sharing, unpublishing, deletion, data clearing, and file copies, including into a Project | Asks for every call with a fresh review |
| Capability calls from a shared Studio App the user does not manage | Asks for every call, reads included |
| `local_bash` in `cld assistant --allow-bash` | The terminal asks `Y/n` for every command |

Read `approval` and `destructive` for each Action in
`cld capabilities catalog --json`; a missing `approval` field means it asks
every time. For example, `spaces.task.create` and `mail.draft.send` ask every
time, while `spaces.task.update`, `mail.draft.create`, and
`notebooks.note.edit` are rememberable.

A remembered approval applies to the same user, Action, and app-owned scope.
Users review and revoke them under **Assistant settings > Approvals**. There is
no `cld` command to list or revoke them. Approval confirms intent; the app
still checks permissions afterward.

In print mode, pass `--approve <exact-tool-name>` only for operations the user
authorized. An unresolved approval exits with status `2`; resolve it with
`cld assistant actions list|approve|reject`. `actions approve --always`
remembers a rememberable approval, so use it only when the user asked for that.

## Scheduled tasks and mandates

A scheduled task belongs to one chat and runs as that chat's owner, with the
owner's full account, including an administrator role. Each call checks the
owner's current access when it runs.

Creating a task also creates its **mandate**: a stored, confirmed authorization
for that one background workload. Its `grants` list names every capability the
task may call. Background runs work like this:

- Every app capability needs a grant, including Queries. That also covers
  opening a Project reference: grant the type's reader Query, such as
  `notebooks` `note.read`. No grants means no app capabilities at all.
- Built-in tools still work without grants, including chat files, memories,
  and the Project's knowledge and files.
- `fixedInput` values must match exactly. Omitted fields are unrestricted
  within the user's access.
- Nothing can be approved during a run. Remembered chat approvals do not apply.
  A call without a matching grant, or a tool that needs approval or a browser,
  fails the run and moves the task to `needs_attention`.
- Only Actions with `approval: "none"` or `"rememberable"` can be granted.
  Cloud rejects any other grant with "Capability always requires interactive
  approval".
- Before each run, Cloud checks that the owner is active, the chat is not
  archived, and the mandate is unchanged. Otherwise the task moves to
  `needs_attention` or stays paused.
- A task in a Project chat uses the Project state that is current when the run
  starts.
- Apps can limit background work further. For example, Grids document stream
  references do not work in scheduled runs.

With today's apps, a scheduled task therefore cannot create Spaces tasks or
send mail, because `spaces.task.create` and `mail.draft.send` always ask. It
can update existing tasks, add comments, edit notes, or create mail drafts when
you grant those Actions. For anything else, let the task write its proposal
into the chat; the user can then ask the Assistant there to carry it out and
approve each step.

```bash
cld capabilities catalog --json
cld assistant tasks create --chat <chat-id> --prompt-file ./daily.md --cron "0 8 * * 1-5" --grants-file ./grants.json --yes
cld assistant tasks get <task-id>
```

`--yes` is required only when the grants list is not empty. Show the user the
exact grants, including unrestricted fields, and pass `--yes` only after they
approve that scope.

Before a run starts, Cloud checks the owner's Assistant cost budget. The run's
model usage then counts as background AI usage, which the administrator's
background stop limits, not the owner's chat budget.

## Instructions, Skills, memories, or knowledge

| | Project instructions | Skill | Memory | Project knowledge |
| --- | --- | --- | --- | --- |
| Scope | Chats in one Project | Everyone with Skill access or a linked Project | One user, all chats | Chats in one Project |
| In context | Every turn | Name and description every turn; instructions loaded when relevant | Up to 20 entries every turn; beyond that, pinned and relevant ones within 6,000 characters | Title list every turn; content on demand |
| Treated as | Instructions | Instructions, below Project instructions | Personal context, not instructions | Data |
| Edited by | Project `admin` | Skill `write` | The user, and the Assistant itself | Project `write` |
| Size | 16,000 characters | 100,000 characters; 10,000 when created through a capability | 500 characters per entry | 100,000 characters per entry |
| Use for | Project rules, tone, routing, output format | Reusable workflows across Projects | Personal facts, preferences, default resources | Reference text such as guidelines |

Precedence, highest first: platform rules, organization instructions, the
user's current request, Project instructions, Skills. `cld assistant prefs
system-prompt` previews the composed prompt for a new chat.

Commands:

- Instructions: `cld assistant projects create "<name>" --instructions-file rules.md`
  or `projects update`.
- Skills: create one in **Assistant settings > Skills**, or with
  `cld capabilities action core ai.skill.create --input-file skill.json --idempotency-key <key>`
  using `{name, description, instructions}`. Then share it, or link it with
  `projects skills link <project> <skill-id> --yes`.
- Memories: `cld assistant personalization add preference|fact --content "..."`.
  They belong to the signed-in user, so add them only for that user. Unless the
  user turned learning off (`personalization configure`), the Assistant also
  learns memories from completed turns in their own chats, Project chats
  included.
- Knowledge: `cld assistant projects knowledge add "<project>" "<title>" --content-file text.md`.

## Files

Chat files belong to one chat and its owner. They are versioned, and the
Assistant can read and write them (`cld assistant files`). Project files are
read-only inside a chat. To use a Project file as a base, the Assistant copies
the text into a chat file. Copy between chats, Projects, and Apps with
`cld assistant code file-copy`; the Assistant can do the same after approval,
and copying into a Project needs Project `write`.

## Models and limits

- `cld assistant models` lists the models the user may use. A Project default
  model or an explicit `--model` that is not allowed fails; Cloud does not
  switch models silently.
- Administrators can restrict models and set a turn time limit (default 30
  minutes) and optional cost budgets (off by default).
- A turn accepts up to 16 attachments; images are limited to 10 MiB each and
  40 MiB together.

## What it cannot do

- Exceed the user's own permissions, act as another user, or read another
  user's chats.
- Change Project instructions, knowledge, references, linked Skills or Apps,
  or access. Those need `cld assistant projects` or the Project settings.
- Use apps that publish no capabilities, or Actions an app does not offer.
- Approve its own Actions. Scheduled runs cannot ask for approval at all.
- Run a shell or reach your machine, except through
  `cld assistant --allow-bash` with a `Y/n` prompt for every command.
- Treat retrieved content, knowledge, files, or memories as instructions.
