# How the Assistant works

Read this before you set up Projects, knowledge, references, Skills, memories,
or scheduled tasks for someone. It explains what the Assistant can see, what it
may change, and in whose name. The [Assistant CLI](index.md) reference holds the
full command syntax.

In short:

- The Assistant always acts as the person who is chatting, with that person's
  current Cloud permissions. It never gets more access than they have.
- A Project reference is a pointer that the Assistant reads live, with the
  reader's own access. Project knowledge and files are copies, and every Project
  member can read them.
- App reads never ask for approval. Changes to app data ask first, unless the
  app marks the Action as safe without approval.
- Scheduled tasks can use only the capabilities granted to the task. Nothing
  can be approved while a task runs in the background.

## What the Assistant is

The Assistant is each user's personal Cloud agent. Every chat belongs to one
user. Chats in a Project stay private to the person who started them. The agent
runs in Cloud, not on your machine; local shell access exists only in an
interactive `cld assistant --allow-bash` session.

It works with two kinds of tools:

- **Built-in tools:** chat files, document reading, web search and import, PDF
  creation, Code Mode, memories, Skills, and the current Project's knowledge and
  files.
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
Project, which makes it the Project `admin`; grant the person access so they
can use it.

For a shared Project this means:

| Situation | Result |
| --- | --- |
| A member can read the referenced note | The Assistant reads the current note in that member's chats |
| A member cannot read the referenced note | The read fails in that member's chats; nothing is exposed |
| A member has Project `read` access | They can read the Project's instructions, knowledge, and files, and the Assistant uses them in their chats |
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
| Skills | `projects skills link` | A link to a separate Skill | Its current instructions, loaded when relevant | Skill limits |
| Studio Apps | `code project-link` | A link to a separate App | The latest publication | App limits |

Each turn starts from the Project's current revision. A retry reuses the
snapshot of its original turn. Instructions are the only instructions in a
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
it to the Assistant on every turn. It grants nothing.

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
mail, updating Grids records, creating Skills, and scheduling chat tasks. Check
`cld capabilities catalog --json` for the current set.

Changes happen in the user's name. The app records the user as the author or
actor, as it would for a change in its own UI. Cloud also logs each capability
call with origin `assistant` and the user, which operators see in Gateway Ops
observability. The chat keeps the tool call and its result. Declined approvals
are logged as `rejected`.

Without any approval, the built-in tools change only the chat's own files and
the user's memories.

## Approvals

The owning app decides in its capability manifest whether an Action asks
first. Users and administrators cannot loosen that policy.

| Operation | Approval |
| --- | --- |
| Query, such as search or read | Never |
| Action with `approval: "none"` | Never |
| Action with `approval: "rememberable"` | Asks; the user may choose **Always approve** for the app's scope |
| Action without `approval` | Asks for every call; cannot be remembered or granted to a scheduled task |
| Built-in tools on chat files, memories, web search, PDFs, and Code Mode | Never; capability calls inside Code Mode still ask |
| Capability calls from a shared Studio App the user does not manage | Asks for every call, reads included |
| `local_bash` in `cld assistant --allow-bash` | The terminal asks `Y/n` for every command |

Read `approval` and `destructive` for each Action in
`cld capabilities catalog --json`. For example, `spaces.task.create` and
`mail.draft.send` ask every time, while `notebooks.note.edit` is rememberable.

A remembered approval applies to the same user, Action, and app-owned scope.
Users review and revoke them under **Assistant settings > Approvals**. There is
no `cld` command for this. Approval confirms intent; the app still checks
permissions afterward.

In print mode, pass `--approve <exact-tool-name>` only for operations the user
authorized. An unresolved approval exits with status `2`; resolve it with
`cld assistant actions list|approve|reject`.

## Scheduled tasks and mandates

A scheduled task belongs to one chat and runs as that chat's owner. Each call
checks the owner's current access when it runs.

Creating a task also creates its **mandate**: a stored, confirmed authorization
for that one background workload. Its `grants` list names every capability the
task may call. Background runs work like this:

- Every app capability needs a grant, including Queries. No grants means no app
  capabilities at all; built-in tools such as chat files still work.
- `fixedInput` values must match exactly. Omitted fields are unrestricted
  within the user's access.
- Nothing can be approved during a run. Remembered chat approvals do not apply.
  A call without a matching grant, or a tool that needs approval or a browser,
  fails the run and moves the task to `needs_attention`.
- Actions without an `approval` policy cannot be granted, so Cloud rejects the
  task with "Capability always requires interactive approval".
- Before each run, Cloud checks that the owner is active, the chat is not
  archived, and the mandate is unchanged. Otherwise the task moves to
  `needs_attention` or stays paused.
- A task in a Project chat uses the Project state that is current when the run
  starts.

```bash
cld capabilities catalog --json
cld assistant tasks create --chat <chat-id> --prompt-file ./daily.md --cron "0 8 * * 1-5" --grants-file ./grants.json --yes
cld assistant tasks get <task-id>
```

Show the user the exact grants, including unrestricted fields, and pass `--yes`
only after they approve that scope.

## Instructions, Skills, memories, or knowledge

| | Project instructions | Skill | Memory | Project knowledge |
| --- | --- | --- | --- | --- |
| Scope | Chats in one Project | Everyone with Skill access or a linked Project | One user, all chats | Chats in one Project |
| In context | Every turn | Name and description every turn; instructions loaded when relevant | Up to 20 entries every turn; beyond that, pinned and relevant ones within 6,000 characters | Title list every turn; content on demand |
| Treated as | Instructions | Instructions, below Project instructions | Personal context, not instructions | Data |
| Edited by | Project `admin` | Skill `write` | The user, and the Assistant itself | Project `write` |
| Size | 16,000 characters | 10,000 characters when created through a capability | 500 characters per entry | 100,000 characters per entry |
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
  They belong to the signed-in user, so add them only for that user.
- Knowledge: `cld assistant projects knowledge add "<project>" "<title>" --content-file text.md`.

## Files

Chat files belong to one chat and its owner. They are versioned, and the
Assistant can read and write them (`cld assistant files`). Project files are
read-only to the Assistant. To use a Project file as a base, it copies the text
into a chat file. Copy between chats, Projects, and Apps with
`cld assistant code file-copy`.

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
- Change Project instructions, knowledge, files, or access. Those need
  `cld assistant projects` or the Project settings.
- Use apps that publish no capabilities, or Actions an app does not offer.
- Approve its own Actions. Scheduled runs cannot ask for approval at all.
- Run a shell or reach your machine, except through
  `cld assistant --allow-bash` with a `Y/n` prompt for every command.
- Treat retrieved content, knowledge, files, or memories as instructions.
