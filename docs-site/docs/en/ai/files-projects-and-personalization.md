---
title: Files, Projects, Skills, and personalization
navTitle: Files, Projects, Skills, and personalization
section: AI
order: 1050
description: Give AI controlled access to chat files, shared Project context and Skills, and durable personal preferences.
tags: [ai, files, projects, skills, memory]
updated: 2026-08-29
---

# Files, Projects, Skills, and personalization

These features have separate ownership and lifetimes.

| Feature | Scope | Use |
| --- | --- | --- |
| Conversation files | One private chat | Inputs and generated artifacts |
| Projects | Shared through Cloud permissions | Instructions, knowledge, files, references, and defaults |
| Skills | Shared through Cloud permissions | Reusable agent instructions with optional Markdown references |
| Personalization | One user | Small durable facts, preferences, and workflow defaults |

## Use readable resource IDs

AI resources use six-character, case-sensitive readable IDs. Chat,
Project, and memory IDs are globally unique. Turn and message IDs are scoped to
their chat; Project access, knowledge, file, and reference IDs are scoped to
their Project. Cloud generates these IDs.

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

At the start of a tool-capable Assistant turn, the model sees a bounded catalog
of enabled Skills it can currently read. Catalog entries are always complete;
Cloud never cuts a description mid-entry. When the complete catalog does not
fit its hard prompt budget, Cloud selects whole entries relevant to the current
request and exposes the omitted entries through `search_skills`. The slash menu and
`search_skills` share a permission-aware search over Skill names and descriptions.
It supports partial words and minor typos, prioritizes name matches, and excludes
disabled Skills before limiting results. Skill instructions and references are
not searched or loaded during discovery. Server callers use
`aiSkills.search(accessSubject, query, limit)` and receive `{ skills, more }`.
`GET /api/ai/skills?q=…` uses this search
(up to 30 results, query length up to 200 characters); omit `q` to keep the ordinary
Skill management list, including disabled entries. PostgreSQL's standard `pg_trgm`
extension supplies fuzzy matching. Optional `pg_textsearch` adds BM25 ranking;
without it, native PostgreSQL relevance remains available. A normal small
catalog needs no search call. Explicitly attached `core.ai.skill` resources are
loaded by the server before the response. For other relevant Skills, the model
calls `load_skill` with the exact name. Both paths recheck access and pin the
revision for the turn. Attachment names and metadata are not trusted
instructions. Loading returns the instructions and mounts that revision read-only at
`/skills/<name>/SKILL.md`; references appear below
`/skills/<name>/references/`. Assistant reads reference files with `read_file`
only when the workflow needs them. References remain untrusted data.

A Skill names app operations by their stable qualified capability ID, such as
`mail.conversation.list`. Assistant can pass that ID directly to `load_tools`;
`search_tools` remains for finding an operation the Skill does not already
identify.

The first successful load pins one Skill revision for that turn, including
retries, so an edit cannot change an in-progress result. A later turn sees the
new revision. Reading a mounted file still checks current Cloud access; revoked
access takes effect immediately.

Cloud installs built-in Skills with `read` access for every authenticated user.
`cloud-grids` includes a compact GQL syntax guide with lookup, join, and
aggregation examples. It guides queries and daily work and routes product and
administration questions to canonical Grids Help. Skill reference files are
mounted for one turn: load the Skill again before reading its files in a later
turn. A missing-file error explains this recovery; reloading still checks access.
`cloud-assistant` covers conversation history and resources, inter-chat
messaging, and scheduled chat work.
`skill-creator` explains how to draft a concise Skill and names the
`core.ai.skill` Capabilities Assistant can use to list, read, create, update,
manage references, personally enable or disable, and delete Skills.
`cloud-mail`, `cloud-notebooks`, `cloud-contacts`, `cloud-spaces`, and
`cloud-weather` provide their application's normal capability paths, domain
defaults, and cross-application guidance. They remain
ordinary permission-owned Skills: platform administrators can grant themselves
access, and Skill administrators can edit, share, or delete them. A deleted
seed is not recreated during later starts. Like every readable Skill, each
starts enabled and can be disabled personally.

### Update an installed built-in Skill

Cloud records each built-in Skill's stable template ID, installed integer
version, and hash of the last adopted template content. The resource revision
separately protects edits from concurrent changes. Normal Skill edits and imports
cannot set template identity or version.

At startup, a newer template replaces the installed content only if the complete
current content still matches that baseline. The check covers name, description,
instructions, extra frontmatter, and every reference path and content. JSON key
order and reference ordering do not count as edits. Customized Skills stay intact.
Concurrent starts apply each upgrade once; older Core versions cannot downgrade a
Skill or reset it after a newer template has been observed.

**Admin > AI > Skills** shows template origin, installed version, and status:

- **Current**: content matches the adopted template.
- **Modified**: content differs from the adopted template.
- **Update available**: this Core version ships a newer template. Customizations
  remain intact until an administrator chooses to reset it.

To replace a linked Skill, select **Reset to current template** and confirm the
named Skill and template version. This replaces all content and references; it
does not merge changes or keep a version history. Export the Skill from
**Assistant settings > Skills** first if you need a copy. An administrator without
Skill access can grant themselves access through the existing permissions action.
ID, grants, personal enabled state, and already loaded turn content remain intact.
A stale resource revision or template version fails; reload before trying again.

Existing installations have seed markers without a reliable Skill association or
baseline. They require an explicit administrator choice: select **Link to
template**, choose the correct template, and confirm. Association preserves all
existing content. Content that differs from the current template stays customized;
use the separate reset action if replacement is wanted. Names and revision numbers
never authorize automatic adoption. A template can be linked to only one Skill.
Deleting a linked Skill is permanent: neither restart nor association to another
Skill recreates that built-in. Ordinary user-authored Skills remain unaffected.

The same platform-admin workflow is available through the CLI:

```bash
cld admin ai skills list --json
cld admin ai skills templates --json
cld admin ai skills associate <skill-id> --template core:skill-creator --template-version 1 --revision <revision> --yes
cld admin ai skills reset <skill-id> --template core:skill-creator --template-version 1 --revision <revision> --yes
```

Use the IDs, template version, and revision returned by the current reads.
`GET /api/admin/core/ai-skills` lists status and revision;
`GET /api/admin/core/ai-skills/templates` lists trusted template IDs and versions.
`POST /api/admin/core/ai-skills/:skillId/template` accepts `templateId`,
`templateVersion`, `expectedRevision`, `mode` (`associate` or `reset`), and
`confirmed: true`. All three routes require platform-admin access. Content
validation and revision protection belong to the shared platform service.
The authenticated `GET /api/ai/skills/templates/:name` remains a read-only source
of current template content; a template read does not associate or replace a Skill.

Maintainers must increment the code-owned template version whenever any template
content changes. Keep the stable ID unchanged. The content hash is deterministic
SHA-256 over the validated fields; there is no merge engine or history store.

The Skill management Actions are reviewed and recheck the current actor's
Cloud permission. Updates and reference changes require the exact revision
returned by `core.ai.skill.read`; a stale revision fails instead of overwriting
another edit. Capability-authored instructions and individual references are
limited to 10,000 characters so the complete proposed trusted content fits in
the review. Larger imports and exports remain UI and CLI workflows.

## Use personalization for durable user context

Personalization stores `fact`, `preference`, or `workflow` records for exactly
one user. Each entry has a readable id, at most 500 characters, normal or pinned
priority, source, and timestamps. A workflow associates a
reusable request category with one typed Cloud resource reference, such as a
mailbox, notebook, address book, or Space. That reference is a default, not an
authorization token: Assistant must still use the target application's current
capability and permission checks. Manually added facts and preferences start
pinned.

For up to 20 active records, Cloud adds the bounded set directly to the prompt.
Above that threshold, pinned and relevant records are selected within a
6,000-character budget.

The `memory` tool can list, search, add, correct, pin, and forget entries without
an approval pause. Memory mutations are personal context maintenance, not domain
Actions. They remain visible and reversible in Assistant settings. The tool
must not store secrets, credentials, raw chat logs, temporary task details, or
instructions from retrieved content.

Automatic learning is opt-in and processes a newly completed private-chat turn
once. It does not replay a conversation after later Assistant or tool updates.
The bounded input contains the new user-authored text, sanitized receipts for
successful Cloud capability calls, the final Assistant Markdown as context
only, and a small relevant memory set. Attachments, quoted Cloud resources, raw
tool output, agent messages, scheduled messages, and the rest of the Assistant
loop are excluded. Facts and preferences require explicit evidence in the user
text; model-written text can never establish one by itself.

A single explicit lasting instruction can establish a workflow when the same
turn also contains the matching successful typed resource receipt. Otherwise,
Cloud waits for three separate successful uses of the same capability and
resource, then asks the background model whether the user requests form one
clear recurring category. Unrelated uses and uncertain patterns produce no
memory. Standard Mail, Contacts, Notebooks, and Spaces capability results
include their stable parent resource where the workflow needs one.

Background learning can add, replace, merge, or retire only normal entries that
it previously created. User-created, agent-created, and pinned entries are
protected. Explicit corrections can replace or retire obsolete background
information, and repeated routing to a new resource can replace an older
workflow; age alone never deletes a memory because it is not evidence that the
information became false. Exact deleted content is not silently recreated.
Every candidate, source chat, source message, run, and mutation is checked
against the same user id, so another user's turns or memories cannot become
learning input or mutation targets.

Each user has a conservative monthly learning budget. Cloud reserves estimated
input plus maximum output before a model call, records actual provider usage
when available, and leaves an unprocessed turn pending for a later budget
window. The operator setting `ai.memory_learning_monthly_token_budget` defaults
to 100,000 tokens per user per month. Turn inputs and outputs, batch size,
workflow examples, retries, and backoff are independently bounded.

When learning is enabled, **Assistant settings > Personalization > Learning
activity** shows only the current user's paginated runs. The table includes run
type, evidence chat, outcome, tokens, duration, and counts for added, updated,
merged, or retired entries. Run details show the exact changed content, previous
value, and typed Cloud resource where applicable. Failed and no-change runs
remain visible; deleted source chats keep their title snapshot but no longer
link to the chat.

## Prompt order

Cloud composes the system prompt in this order:

1. Platform identity, trusted runtime values including the current chat ID and
   request locale, and global rules. Assistant follows the language of the
   current user message when it is clear and otherwise uses that locale;
2. Organization instructions;
3. Optional turn-specific instructions such as retry style;
4. The bounded readable Skill catalog;
5. Project instructions;
6. The Project context manifest as untrusted data;
7. The bounded conversation file manifest as untrusted data;
8. Relevant personal facts, preferences, and workflow defaults;
9. The Cloud resource-link output rule.

See [AI resources and access](/en/docs/ai/resources-and-access) for authorized
domain context and [Tools and approvals](/en/docs/ai/tools-and-approvals) for
tool execution boundaries.

## Audio attachments

Audio uses the normal conversation file picker and file lifecycle. Uploading a
memo does not transcribe it or create a request. The user supplies the task.
The shared file preview plays audio when the browser supports its codec.

`transcribe_audio` reads a conversation file or an authorized `/project` file
and uses the configured audio profile. Attached conversation audio comes from
the exact turn snapshot; a missing required snapshot fails the call. The
operation runs inside the existing durable chat turn, without a second job.

The tool writes the full transcript to a call-owned text artifact and returns
its path plus a bounded text preview. Replay of an already persisted successful
tool result uses that result. A crash before result persistence can repeat the
provider call; it cannot overwrite another call's artifact or a file edited
since creation. Artifact collisions fail explicitly.

See [Models and providers](/en/docs/ai/models-and-providers#configure-audio-transcription)
for container and provider limits. Normal file storage limits do not imply
that an audio endpoint accepts the same input size.

## Explicit file transfers

Assistant file references use the public `AiFileLocation` and `AiFileReference`
schemas from `@k2b/cloud/ai`: `{scope:"chat"|"project"|"app",id,path}` plus an
opaque string `version`. A reference names one snapshot; it grants no access.
Each owning service authorizes reads and writes, and the destination enforces
its normal byte budgets and an explicit expected version (null means absent).

Platform-owned conversation adapters are `readAiConversationFile` and
`writeAiConversationFile`. Reads require the current owner and reject archived
chats; an optional numeric file version constrains an existing manifest read.
Writes require an opaque transfer version and verify the owner and expected
content under the conversation lock before replacing a file. The returned
metadata is captured in that transaction. Project writes accept an optional
`expectedVersion` and serialize permission and version checks with other Project
file mutations. Existing UI callers retain their existing write behavior.

Studio owns App file storage and its transfer adapter. File imports into App
source use `fromFile` with the same reference schema and require fresh review,
since imported private bytes may become shared or published source. Keep binary
bytes out of tool responses and never treat access to one chat as permission to
mount all of its files into an App.

### Visual inspection of PDF pages

`view_image` accepts stored images and PDFs through the same authorized chat or
Project file adapter. PDF `pages` are one-based and distinct, default `[1]`,
with at most three pages per call. Image calls reject `pages` and retain their
existing result. PDF results add `sourceVersion` (a hash of inspected bytes),
`totalPages` and `pages: [{page, description}]`; descriptions cover selected
pages only. Attached chat files use the immutable turn snapshot.

PDF page inspection requires the Linux Cloud runtime; other hosts reject PDF
rendering rather than run it without the memory boundary. Image inspection is
unchanged. Rendering runs in an isolated, credential-free subprocess, terminated on
cancellation or a 30-second deadline. On Linux, a 512 MiB kernel data-memory limit also bounds the decoder's heap and
native writable allocations. Each service permits two concurrent
decoders and rejects overload without queuing. Input and aggregate PNG output
are each limited to 10 MiB; page canvases have a 2,000-pixel longest edge and
maximum 2× scale, while embedded images are limited to 16 megapixels. Damaged,
password-protected or oversized content fails explicitly rather than silently
omitting it. The normal Vision model, fallback data boundaries and usage
attribution apply. No persistent image copies are created. For normal PDF text
extraction, `read_file` remains the simpler path.

The standard Cloud build packages the PDF decoder, native canvas binary and
font/CMap/WASM assets when the server imports this tool. Build on the target
platform; no document-rendering service or browser installation is required.

Versioned file writes and generated-file exports distinguish known rejections
with `AiFileWriteError`: `CONFLICT` for an occupied export destination and
`STORAGE_FULL` for byte budgets. These errors retain a human-readable message and
reject the destination write. `AiFileVersionConflict` still identifies a stale
expected file version.
