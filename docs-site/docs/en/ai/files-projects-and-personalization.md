---
title: Files, Projects, Skills, and personalization
navTitle: Files, Projects, Skills, and personalization
section: AI
order: 1050
description: Give AI controlled access to chat files, shared Project context and Skills, and durable personal preferences.
tags: [ai, files, projects, skills, memory]
updated: 2026-08-22
---

# Files, Projects, Skills, and personalization

These features have separate ownership and lifetimes.

| Feature | Scope | Use |
| --- | --- | --- |
| Conversation files | One private chat | Inputs and generated artifacts |
| Projects | Shared through Cloud permissions | Instructions, knowledge, files, references, and defaults |
| Skills | Shared through Cloud permissions | Reusable agent instructions with optional Markdown references |
| Personalization | One user | Small durable preferences and facts |

## Use readable resource IDs

AI resources keep UUID primary keys for database relationships and use
six-character, case-sensitive readable IDs at user and agent boundaries. Chat,
Project, and memory IDs are globally unique. Turn and message IDs are scoped to
their chat; Project access, knowledge, file, and reference IDs are scoped to
their Project. Cloud generates these IDs and retries the insert on a collision.

URLs, Assistant capabilities, streamed chat events, and `cld assistant`
commands use the readable IDs. Database UUIDs are not a fallback input format.

## Store conversation files

Chat routes expose a Postgres-backed file system below each conversation. Paths
are absolute in one namespace, such as `/photo.jpg` or `/reports/summary.md`,
and reject `..` segments. Each file records whether it came from the user or
the assistant; tools cannot overwrite a user upload. Default limits are 50 MB
per file and 250 MB per conversation. Forking a conversation copies its files.

Every composer attachment is uploaded first. Messages and durable turn
configuration keep file references instead of inline binary data. For each
turn, Cloud snapshots the exact newly attached files and a bounded, newest-first
file inventory into the system context as untrusted metadata. Attached file
versions are copied atomically with the turn, so retries use the same bytes even
when the conversation file changes later. A turn accepts at most eight files,
10 MB per image, and 40 MB of image input in total. Use `list_files` for the
complete inventory and `read_file` or `view_image` before relying on a file's
contents. In a Project chat, the same tools expose authorized shared Project
files read-only below `/project`.

When the selected chat model supports Vision, Cloud resolves newly attached
images transiently for that provider request; the stored message remains
reference-only. Tool-capable models also receive `view_image` so they can
inspect a stored image again on a later turn. The selected model performs that
inspection when it supports Vision; otherwise an administrator must configure
a separate Vision tool model. The tool accepts an image path and optional
inspection guidance. It reads only an authorized conversation or Project file,
stays inside the application's allowed data boundary, and returns a bounded
textual analysis. A model with neither Vision nor Tools cannot accept image
attachments.

The default Assistant tools can list files, read bounded UTF-8 slices, write
assistant-owned text files, inspect supported images when configured, and
present downloads. They can also turn an assistant-written conversation `.md`
file into a sibling `.pdf`: the agent writes or edits the Markdown with
`write_file`, calls `markdown_to_pdf` with an optional A4 preset and custom CSS,
then presents the returned PDF path. Project files remain read-only and cannot
be converted directly. `read_file` returns text directly and automatically converts
PDF, Office, OpenDocument, RTF, EPUB, and CSV files to bounded Markdown. Its
`mediaType` remains the original file type while `representation` is `text` or
`markdown`. Offsets count bytes in that UTF-8 representation; continue with
`nextOffset` until `eof`. `truncated` reports when document extraction reached
its output bound, not when another slice is available. Document content remains
untrusted data and is never promoted to instructions or personalization input.

Images stay on `view_image`. Unsupported binaries, encrypted or malformed
documents, image-only PDFs that require OCR, and documents above the extraction
limit return bounded errors. These tools do not execute code or access the host.
Keep authorization at the conversation route; a file path is not an access
token. See [Document extraction](/en/docs/platform/document-extraction) for the
shared conversion contract and limits.

## Use Projects for shared working context

A Project owns a name, description, icon, instructions, optional default model,
shared text knowledge and files, Cloud resource references, and `read`, `write`,
or `admin` grants. Creating a Project atomically creates an explicit `admin`
grant for the creating user or service account. Cloud resolves direct and nested
group membership from the authoritative account database.
Projects have no account owner and survive principal deletion. Project access
changes cannot remove the final admin grant; if an operator deletes the sole
admin principal outside the Project service, operator recovery is required to
add a new grant directly. A platform administrator can find Projects without a
remaining admin and restore their access under **Admin > AI > Projects**. This
recovery surface can also permanently delete obsolete Projects, but it does
not expose Project contents or private chats.

Project chats remain private to their creator. Sharing a Project does not share
chat history. A chat has at most one current Project. Its owner may choose,
change, or clear that Project between turns. A change affects only future turns
and is rejected while a turn is queued, running, or waiting for attention.

When a turn is submitted, Cloud rechecks access and stores an immutable snapshot
with the Project id, name, revision, instructions, context manifest, and model
default. Past messages do not change when the current Project changes. Retries
reuse that turn's snapshot; new turns use the current Project and revision.
Workers recheck current access before execution. `search_project`,
`read_project_knowledge`, and every read below the virtual `/project` file mount
recheck it before returning data. `search_project` returns metadata only;
knowledge is read with `read_project_knowledge`, documents with `read_file`, and
images with `view_image`.
The mount is never writable and does not copy shared bytes into a private chat.

Only Project instructions are instruction-bearing. Knowledge, files, references,
and tool results are untrusted data. References contain metadata only; the agent
must use the target app's current authorized capabilities to read the source.

The Assistant Project workspace lets users with `write` access manage basic
metadata, knowledge, files, and Cloud resource references. Because Project
instructions and the default model change trusted agent behavior, only
`admin` users may edit them or manage Project access. Reference selection uses
Universal Search and can be filtered by application. The HTTP API and
`cld assistant projects` expose the same metadata, context, and access model.

## Reuse shared Skills

A Skill gives Assistant a reusable workflow without attaching it to one person
or Project. Open **Assistant settings > Skills** to create one, import a
`SKILL.md` or Skill ZIP, edit its Markdown instructions, add Markdown files
below `references/`, export it, or manage its Cloud access. `read` access can
view and use a Skill, `write` can edit it, and `admin` can also share or delete
it. The final admin grant cannot be removed.

If the sole Skill administrator is removed outside the Skill service, a
platform administrator can restore access under **Admin > AI > Skills**. The
same recovery surface can grant access to or permanently delete any Skill.

`SKILL.md` is the portable source of truth. It starts with YAML frontmatter
containing a lowercase, hyphenated `name` and a `description`, followed by the
Markdown instructions. Cloud currently accepts optional `license`,
`compatibility`, `metadata`, and `allowed-tools` frontmatter. A ZIP may wrap the
files in one Skill folder and may contain Markdown files directly below
`references/`. Scripts, assets, nested references, and other files are rejected.
A Skill without references can also be imported or downloaded as one bare
`SKILL.md`.

At the start of a tool-capable Assistant turn, the model sees the names and
bounded descriptions of every Skill it can currently read. It must call
`load_skill` with the exact name before following a Skill. The call rechecks
access, returns the instructions, and mounts that revision read-only at
`/skills/<name>/SKILL.md`; references appear below
`/skills/<name>/references/`. Assistant reads reference files with `read_file`
only when the workflow needs them. References remain untrusted data.

The first successful load pins one Skill revision for that turn, including
retries, so an edit cannot change an in-progress result. A later turn sees the
new revision. Reading a mounted file still checks current Cloud access; revoked
access takes effect immediately.

Cloud seeds two Skills once with `read` access for every authenticated user.
`skill-creator` explains how to draft a concise Skill and names the
`core.ai.skill` Capabilities Assistant can use to list, read, create, update,
manage references, personally enable or disable, and delete Skills.
`cloud-mail` provides the normal Cloud Mail capability paths, composition
defaults, and cross-application guidance. After their initial seed they are
ordinary permission-owned Skills: platform administrators can grant themselves
access, and Skill administrators can edit, share, or delete them. A deleted
seed is not recreated during later starts. Like every readable Skill, each
starts enabled and can be disabled personally.

The Skill management Actions are reviewed and recheck the current actor's
Cloud permission. Updates and reference changes require the exact revision
returned by `core.ai.skill.read`; a stale revision fails instead of overwriting
another edit. Capability-authored instructions and individual references are
limited to 10,000 characters so the complete proposed trusted content fits in
the review. Larger imports and exports remain UI and CLI workflows.

## Use personalization for durable user context

Personalization stores `fact` or `preference` records for one user. Each entry
has a readable id, at most 500 characters, normal or pinned priority, source, and
timestamps. Manually added entries start pinned.

For up to 20 active records, Cloud adds the bounded set directly to the prompt.
Above that threshold, pinned records come first and PostgreSQL full-text search
selects relevant records within a 6,000-character budget. Native FTS is always
available; Cloud optionally uses the exact `pg_textsearch` BM25 index and falls
back for known extension-capability failures.

The `memory` tool can list, search, add, correct, pin, and forget entries without
an approval pause. Memory mutations are personal context maintenance, not domain
Actions. They remain visible and reversible in Assistant settings. The tool
must not store secrets, credentials, raw chat logs, temporary task details, or
instructions from retrieved content. Automatic learning reads only user-authored
text, strips attachment markers, ignores resource refs, Assistant output, and
tool results, and never deletes a memory. It is controlled by the user's
personalization setting.

## Prompt order

Cloud composes the system prompt in this order:

1. platform rules;
2. organization instructions;
3. code-owned personal-agent instructions;
4. the readable Skill catalog;
5. Project instructions;
6. the Project context manifest as untrusted data;
7. the bounded conversation file manifest as untrusted data;
8. relevant personal facts and preferences;
9. the final execution reminder.

See [AI resources and access](/en/docs/ai/resources-and-access) for authorized
domain context and [Tools and approvals](/en/docs/ai/tools-and-approvals) for
tool execution boundaries.
