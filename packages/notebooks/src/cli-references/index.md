# Notebooks CLI

## What Notebooks is

Notebooks are collaborative workspaces for structured, real-time synchronized notes. Notes remain readable Markdown while links, tags, attachments, named data blocks, queries, and formulas add navigation and summaries.

Use `cld notebooks` to read and write notes by ID or path, keep a notebook as a local folder of Markdown files, search knowledge, manage access, and export data. Use the browser when a task depends on live collaborative editing or visual layout.

## Contents

- [Core model](#core-model)
- [Markdown knowledge conventions](#markdown-knowledge-conventions)
- [Declarative summaries](#declarative-summaries)
- [Address notes](#address-notes)
- [Agent workflow](#agent-workflow)
- [Notebook as a local folder](#notebook-as-a-local-folder)
- [Read and write notes](#read-and-write-notes)
- [Search and discovery](#search-and-discovery)
- [Named blocks](#named-blocks)
- [Attachments, versions, and exports](#attachments-versions-and-exports)
- [Access, API keys, and snapshots](#access-api-keys-and-snapshots)
- [Command reference](#command-reference)
- [JSON contracts](#json-contracts)
- [Further references](#further-references)

## Core model

- A **notebook** is the access and organization boundary. Its `id` is the immutable six-character ID used by APIs, URLs, and automation. Notebook names are not unique.
- A **note** has Markdown content, tags, an optional parent, timestamps, and an optional permanent lock. Its displayed title is a stored projection of the first H1 or, when no H1 exists, the first visible content line. Notes are addressed by ID, by notebook path, or by a file in a pulled mirror (see [Address notes](#address-notes)), and can link to each other.
- A **named block** is a stable region inside Markdown, such as a table, list, data object, or section. Block-aware edits avoid replacing unrelated note content.
- An **attachment** belongs to a notebook and can be referenced from notes with an `attach://<short-id>` link.
- A **version** is a historical note snapshot. Restoration writes a version into an existing empty target note rather than overwriting arbitrary current content.
- A **query block** lists notes from the same notebook using filters, sorting, and selected fields. It reads data without executing code or changing notes.
- A **table formula** is a cell beginning with `=` in a Markdown table. Formula names are case-insensitive and operate on row values or table columns.

Notebooks can be collaborative. Read current state before changing it and use edit preconditions when another person or agent might update the same note.

## Markdown knowledge conventions

Keep durable knowledge visible in Markdown. Queries and formulas summarize readable source data rather than holding the only copy. Before writing content, read [Notebook Markdown](markdown.md): it lists every block Notebooks renders, such as callouts (`:::warning`), tasks, tables, data blocks, math, and diagrams, with one example each. Use nothing else.

- Headings use normal Markdown (`#`, `##`, and deeper levels).
- Tasks use `- [ ]` and `- [x]`.
- A parsed tag is written as `#tag` in note content, with ASCII characters only.
- A note link is `[Label](note://shortId)`. To open the note at a heading, add the heading's slug: `[Label](note://shortId#backup-restore)` opens the heading "Backup & Restore". A heading the note does not have opens the note at its top.
- A file link is `[Label](attach://shortId)`; an image is `![Alt](attach://shortId)`.
- A named block places `@name` on its own line directly above a table, list, data block, or heading section.

````markdown
@owners
| Name | Role |
|---|---|
| Ada | Maintainer |

@status
:::data
state: ready
reviewed: true
:::

@next-actions
- [ ] Publish the release
- [ ] Verify the deployment
````

Preserve syntax you do not recognize when you edit a note rather than normalizing it away. Legacy fenced `script` blocks remain visible code and never execute. Preserve their source unless the user asks to replace it; there is no script runtime, notebook-local script storage, or script setting.

## Declarative summaries

Use `:::toc` for the current note's headings and `:::query` for lists or tables of notes. Both render in Book and in the editor preview. Their configuration remains Markdown, so `cat`, `write`, and `edit` manage it.

Place data, query, and TOC directives at document level, outside lists, quotes, code examples, and other blocks. Nested examples are not evaluated.

````markdown
:::toc
min-depth: 2
max-depth: 3
:::

:::query
source: notes
scope: notebook
match: all
where:
  - field: $tags
    op: contains
    value: handbook
  - field: status.reviewed
    op: eq
    value: true
sort:
  field: $updated
  direction: desc
columns:
  - $title
  - status.state
limit: 25
:::
````

The example reads `state` and `reviewed` from each note's `@status` data block. You choose block and property names; there are no required wiki metadata fields. Property paths use `block.key`. Each part starts with an ASCII letter and contains at most 64 letters, digits, underscores, or hyphens. Names and keys are case-sensitive.

Data values are strings, numbers, booleans, or flat lists of these values, not nested objects. Write data list items on separate lines with two spaces before `-`; inline arrays belong to query filters, not data blocks. Quote text that would read as a number or boolean, such as `"42"` or `"true"`. Text that starts with `[`, `]`, `{`, `}`, `&`, `*`, `!`, `|`, `>`, `@`, or a backtick must be quoted, or the block is invalid. Each data block allows 64 fields, each list 128 items, and each string 2,000 characters. Duplicate names or keys prevent the affected named data from being indexed.

The configuration is a small YAML-like format, not general YAML. Follow the example's indentation: two spaces for list items and sort fields, four for filter continuations. Use unquoted setting names and field paths. Comments, anchors, nested objects, and arbitrary YAML syntax are not supported.

Query rules:

- `source` must be `notes`; results stay inside the current notebook and require read access.
- `scope` is `notebook` (default, including the current note), direct `children`, or all `descendants`, relative to the note containing the query. Children and descendants exclude the current note.
- `match` is `all` (default) or `any`; nested filter groups are not supported.
- `$title`, `$created`, `$updated`, `$tags`, and named `block.key` properties can be selected or filtered.
- Sort by `$title`, `$created`, or `$updated`, with `asc` or `desc`. The default is `$updated` descending.
- Omitting `columns` produces a list. Selected columns produce a table, with at most 16 columns.
- `limit` is 1–100, default 25. A query accepts at most 32 filters and 100 values in a filter list. A note accepts at most 20 query blocks.

Choose operators for the field's value type:

| Field | Operators |
| --- | --- |
| `$title` | `eq`, `ne`, `in`, `not-in`, `contains`, `starts-with` |
| `$created`, `$updated` | `eq`, `ne`, `in`, `not-in` with RFC 3339 timestamps |
| `$tags` | `exists`, `missing`, `contains`, `contains-any`, `contains-all` |
| `block.key` | `exists`, `missing`, typed `eq`/`ne`/`in`/`not-in`, string `contains`/`starts-with`, numeric `gt`/`gte`/`lt`/`lte`, list `contains-any`/`contains-all` |

`exists` and `missing` take no `value`. Membership operators take a non-empty inline list, such as `[active, draft]`; other operators take one value. Equality preserves types and text case. Text `contains` and `starts-with` ignore case. Tags also ignore an optional `#` prefix. `ne` and `not-in` exclude missing fields; add a `missing` filter with `match: any` when those should match. Empty property lists exist; `$tags` exists only when the note has at least one tag. Without filters, every note in scope matches, including with `match: any`.

Queries read saved notes; a draft preview changes the query being tested, not the indexed properties of its source note. A result limit does not paginate: narrow filters when results are truncated. Queries do not evaluate JavaScript, SQL, regular expressions, or formulas. Invalid blocks show diagnostics rather than partially applying a query.

TOC depths range from 1 to 6, defaulting to 1 and 6, with `min-depth` no greater than `max-depth`. The contents list includes headings before and after the block and filters by heading depth; it does not list child notes.

### Validate a saved page or draft

```bash
cld notebooks preview <note> --json
cld notebooks preview <note> --from ./draft.md --json
```

Preview checks only query and TOC blocks; callouts, data values, and formulas are not validated. It needs an existing note: for a new note, `write` it first, preview the saved page, and correct it with `write --if-content-hash`. To test a draft before it exists, preview it against any note you can write in the same notebook; `children` and `descendants` scopes then refer to that note. Preview requires a user-backed sign-in credential; notebook resource-bound API keys are not supported. Without `--from` or `--content`, it previews the saved page with read access. With a draft it requires write access and an unlocked note, and it never saves. It evaluates queries against saved note data and builds the contents list from the draft headings.

The JSON result contains `markdown`, rendered `blocks` (`line`, `html`), `headings` (`id`, `line`), and `diagnostics` (`line`, `message`). Source lines are 1-based. `headings` includes only headings with an exact source position. Diagnostics produce exit code 1 while retaining the JSON result; a clean preview returns 0. Check diagnostics before applying a draft with `write` or `edit`.

## Address notes

Every command that takes a `<note>` accepts exactly three forms:

1. **Note ID**, such as `ns98Kq`. IDs are unique across all notebooks, survive renames and moves, and need no notebook prefix.
2. **`<notebook>:<path>`**, such as `"Kolb Antik Doku":betrieb/backup`. The notebook part is a notebook ID or its exact name. The path is resolved on the server through the note tree, so it works without a mirror.
3. **A file inside a pulled mirror**, such as `~/docs-mirror/betrieb/backup.md` or `betrieb/backup.md` inside the mirror folder. It is resolved only through the mirror manifest. A mirror folder, such as `~/docs-mirror/betrieb`, addresses the note whose own content is `~/docs-mirror/betrieb/index.md`.

A path segment matches the child notes whose title has the same slug:

- letters are lowercased; `ä ö ü ß` become `ae oe ue ss`; other accents are dropped;
- every other run of characters becomes one `-`, without leading or trailing `-`; at most 80 characters;
- a title without letters or digits becomes `untitled`.

So `Übersicht & Größe`, `übersicht & größe`, and `uebersicht-groesse` name the same note. Titles and notebook names are not unique. When a segment or a notebook name matches more than one candidate, the command fails and lists every candidate with its path and ID; it never guesses. Use the ID from that list.

Notebook-scoped commands (`ls`, `tree`, `pull`, `tags`, `export`, `update`, and the `attachments`, `api-keys`, `snapshots`, and `access` groups) take `<notebook>` as ID or exact name, or a mirror folder. In `ls`, `tree`, and `cp`, `<notebook>:<path>` narrows to a note. `<notebook>:` with an empty path addresses the notebook itself, for example `cld notebooks stat Docs:`.

## Agent workflow

1. Confirm the selected Cloud profile with `cld profile list` when the target instance is not obvious.
2. Find the notebook with `cld notebooks ls --q <text> --json`, which matches a case-insensitive part of the name or description, then look at its structure with `cld notebooks tree <notebook>`. Several matches with the same name need the user's choice; use the ID.
3. Search before creating duplicate knowledge: `cld notebooks search "deployment rollback" --notebook <notebook> --json`.
4. Read the note with `cld notebooks cat <note> --json` and keep `contentHash` and `blocks`.
   For a new note, read [Notebook Markdown](markdown.md), write the draft to a local file, and create the note with `cld notebooks write "<notebook>:<path>" --from draft.md --json`. No mirror is needed for one note.
5. Prefer a named-block or line edit with `edit` over replacing the whole note. Pass the returned hash as `--if-content-hash` or `--if-block-hash`.
6. Run risky edits with `edit --dry-run` first, then repeat without it. `write` has no dry run.
7. Read the result again. A successful request does not prove the intended Markdown structure.

For many notes, or when you want to use normal file tools, pull the notebook into a folder instead: see the next section.

Use `--json` whenever a later action depends on the output. Pass multiline Markdown with `--from <file>` or `--from -` (stdin) instead of shell escaping.

## Notebook as a local folder

`cld notebooks pull <notebook> <dir>` mirrors a notebook into a folder of Markdown files for any local tool (`rg`, an editor, another agent). Pull only downloads. Changes go back through `write`, `edit`, `mv`, or `rm`; they also accept mirror files, and the CLI then updates the local files and the manifest immediately.

### Layout

```text
docs-mirror/
  .cld-notebook.json              manifest
  _attachments/Ab12Cd-plan.png    notebook files
  betrieb/
    index.md                      own content of the note "Betrieb"
    backup.md                     leaf note "Backup"
    checkliste--Xy12Zw.md         two siblings share the title "Checkliste"
    checkliste--Qr34St.md
  readme.md
```

- A note without children is `<slug>.md`. A note with children is a folder whose own content is `<slug>/index.md`.
- When siblings share a slug, each file name carries the note ID: `<slug>--<id>.md` or `<slug>--<id>/`. A note whose slug is `index` always gets the suffix. The suffix exists only in mirror names; `<notebook>:<path>` never accepts it. A mirror file path always works as an address.
- Attachments are downloaded to `_attachments/<id>-<file name>`. In the files, `attach://<id>` links become relative paths such as `../_attachments/Ab12Cd-plan.png`; writing a file back turns them into `attach://` links again.
- Links to notes in the mirror become relative file paths in the same way: `[Backup](note://Ab12Cd#restore)` becomes `[Backup](../betrieb/backup.md#restore)`, so editors, Markdown viewers, and `rg` can follow them. Links to notes outside the mirror stay `note://` links.
- Writing a file back turns every relative link to a note's file in the mirror into a `note://` link, including links you typed yourself, when the link is written the way pull writes it: the shortest relative path, such as `../betrieb/backup.md`, not `./../betrieb/backup.md`. Other relative links are uploaded as they are. Content that `edit` inserts through a mirror file is read the same way. Relative links resolve from the `--from` file when it lies in a mirror, otherwise from the mirror file you write or edit.
- Each file starts with minimal front matter, followed by the exact note content:

  ```markdown
  ---
  id: Ab12Cd
  title: "Backup und Restore"
  updatedAt: 2026-09-25T10:00:00.000Z
  ---
  # Backup und Restore
  ```

  `write` removes this front matter again. Other front matter in your content is kept as content.
- `.cld-notebook.json` records the server, the notebook, and for each note its `path`, `contentHash` (the downloaded note content), `fileHash` (the file pull writes for that content), and `updatedAt`: one entry per note, nothing else. Do not edit it.

### Pull again

Run `cld notebooks pull <dir>` (or `pull <notebook> <dir>`) at any time. Only notes whose `updatedAt` changed are downloaded; renamed and moved notes move their files, and files of deleted notes are removed. When a linked note moves, appears, or is deleted, pull downloads the linking files again and updates their links. Pull reads the saved state; a change that someone is typing in the browser appears after the editor saves it, a few seconds later. `cat` always shows the live content.

A file that differs from the server copy that pull wrote has local changes. While pull keeps a file for local changes, it compares the file with the server copy as it would write it at the current paths, so undoing your edits after a linked note moved still leaves a local change until you run `pull --force`. Pull never discards local changes: it lists the file with the reason and exits 1. Pull touches such a file only so that it can still be written back: when its own note moves, the file moves along with its changes and its relative links follow the new location; when a note it links to moves, that link follows the note, and a link to a note that left the mirror becomes its `note://` link. Everything else stays as you wrote it. If another local file holds the path a note needs, pull leaves that file alone: a moved note keeps its old file, and pull lists that file; a new note is not downloaded, and pull lists the path in the way. `pull --force` discards local changes and makes the folder match the server.

Pull into a new or empty folder only; it refuses a non-empty folder without a manifest. For an empty notebook it writes just the manifest.

### Move a Git docs folder into a notebook

`cld notebooks create` makes an empty notebook. Pull it into a new folder, then write every file of the source folder to the same relative path inside the mirror:

```bash
cld notebooks create "Kolb Antik Doku"
cld notebooks pull "Kolb Antik Doku" ~/docs-mirror
cd ~/Git/kolb-antik-docs
for f in $(find . -name '*.md'); do cld notebooks write ~/docs-mirror/${f#./} --from "$f" --parents; done
```

- `--parents` creates missing folder notes, like `mkdir -p`; a folder note is titled after its folder name.
- The note title is the file's first `# Heading`. A file without one gets its file name as its heading.
- The file lands under the slug of its title, not its original name: `runbooks/create-rocky-vm.md` with `# Create a Rocky Linux VM` becomes `runbooks/create-a-rocky-linux-vm.md`. The CLI prints the final mirror path.
- A `README.md` becomes an ordinary note titled after its heading. To make a file the content of its folder note, write it to `<folder>/index.md`; note that its heading then renames the folder, so write such files last or keep the heading equal to the folder name.
- Running the loop again does not duplicate notes: a new file whose title already exists in that folder is refused with the existing path and ID. Update existing notes through their mirror files instead.
- Run the loop sequentially. Parallel writes that create the same missing folder can create that folder twice.
- A relative link that names a file already in the mirror, as the shortest path from the target file, becomes a `note://` link. A link to a file that the loop writes later stays a relative link; write the linking mirror file once more to turn it into a note link. All other relative links between the Git files (`../x.md`, images) are copied verbatim; fix them afterward with `note://` or `attach://` links (`cld notebooks attach` prints one).

The loop takes well under a second per file.

### Daily edit workflow

```bash
cld notebooks pull ~/docs-mirror                  # refresh
rg -l "backup" ~/docs-mirror                      # read with local tools
$EDITOR ~/docs-mirror/betrieb/backup.md           # change a file
cld notebooks write ~/docs-mirror/betrieb/backup.md   # upload it; the file is refreshed
cld notebooks write ~/docs-mirror/betrieb/neu.md --content "# Neu" --parents   # new note
cld notebooks mv ~/docs-mirror/betrieb/neu.md ~/docs-mirror/archiv/   # move into a folder note
cld notebooks rm ~/docs-mirror/archiv/neu.md --yes
```

- `write <mirror file>` without `--from` uploads the file itself.
- Writes and edits through a mirror file are checked against the manifest `contentHash`. If the note changed on the server since your pull, the write fails with 409 "changed elsewhere, pull first". Then `pull` reports the file as changed on both sides: copy your version aside, run `pull --force`, merge, and write again.
- `edit` through a mirror file refuses a file with unsaved local changes; write the file first.
- Changing the first heading renames the file; moving changes its folder. The mirror follows immediately.

## Read and write notes

### Read

```bash
cld notebooks cat <note>                    # raw Markdown, pipeable
cld notebooks cat <note> --numbered         # with 1-based line numbers
cld notebooks cat <note> --blocks           # named block summary
cld notebooks cat <note> --json             # content plus contentHash, lineCount, blocks
cld notebooks stat <note> --json            # metadata only
```

`cat` reads the live content, including changes from an editor that is open in the browser, so its `contentHash` matches what `write` and `edit` check. A note someone is typing in can still change between your read and your write.

### Write a whole note

```bash
cld notebooks write "Docs:betrieb/backup" --from backup.md --parents
cld notebooks write ns98Kq --from - --if-content-hash "$HASH" <<'MD'
# Backup

Nightly at 02:00.
MD
```

`write` replaces the whole content, or creates the note when the address does not exist yet. A new note is created below the parent path; the last path segment only provides the fallback title. A title that already exists among the new siblings is refused with the existing candidates, so paths stay unambiguous. An address that matches several notes is refused, too.

The title always comes from the first `# Heading`. Without one, `write` adds the file name (new notes) or the current title (existing notes) as the heading. To rename a note, change its heading or use `mv`.

For an ID or `<notebook>:<path>` target, pass `--if-content-hash` from a previous `cat --json` to avoid overwriting someone else's change. A conflict exits 1 with "changed elsewhere".

### Edit precisely

Each `edit` performs exactly one operation. Line ranges are 1-based and inclusive; duplicate block indices are 0-based.

```bash
cld notebooks edit <note> --append --if-content-hash "$HASH" --dry-run --from - <<'MD'

## Follow-up

- [ ] Verify the fix
MD
```

Operations:

- `--append` / `--prepend`: add Markdown at the end or beginning.
- `--replace-lines start:end` / `--delete-lines start:end`.
- `--insert-before-line N` / `--insert-after-line N`.
- `--replace-block <name>` / `--append-block <name>` / `--prepend-block <name>`, with `--type <type>`, `--index <n>`, and `--include-handle`.

Content comes from `--from <file|->` or `--content <text>`. Preconditions: `--if-updated-at <ISO>`, `--if-content-hash <hash>`, `--if-block-hash <hash>`. Use the narrowest one: a block hash permits unrelated edits elsewhere in the note. To replace the whole note, use `write`.

### Organize

```bash
cld notebooks mv <note> "Docs:betrieb"                     # into an existing note
cld notebooks mv <note> "Docs:betrieb/Backup und Restore"  # move and rename
cld notebooks mv <note> "Docs:"                            # to the top level
cld notebooks cp <note> "Archive:2026"                     # copy into another notebook
cld notebooks rm <note> --yes                              # delete with all children
cld notebooks lock <note> --yes                            # permanent lock
cld notebooks favorites add <note>
```

`mv` moves into the target when it names an existing note, like `mv file dir/`. Otherwise the last target segment becomes the new title below its parent path. Moving between notebooks is not supported; use `cp` and `rm`. `rm` and `lock` ask for confirmation in a terminal and require `--yes` otherwise. A lock is permanent. A notebook admin can reserve deleting and locking notes for admins with `cld notebooks update <notebook> --note-delete-permission admin` (`write` restores the default). Then `rm` and `lock` by anyone else fail with status 403 and the message that deleting or locking is reserved for admins (API codes `NOTE_DELETE_ADMIN_ONLY` and `NOTE_LOCK_ADMIN_ONLY`); editing, including removing content, still works. Do not work around the rule by emptying the note; ask an admin instead.

New notes without content get their H1 from the notebook's default note title template (default `New Document`). Change it with `cld notebooks update <notebook> --default-note-title-template '<liquid>'`. The template receives `notebook.id`, `notebook.name`, `note.id`, `note.depth`, `parent.exists`, `parent.id`, `parent.title`, `parent.path`, `date`, `time`, `datetime`, and `timezone`.

## Search and discovery

```bash
cld notebooks search "invoice reconciliation" --json
cld notebooks search "deploy" --notebook Docs --tags finance,monthly --updated-after 2026-07-01T00:00:00Z --json
cld notebooks ls                         # notebooks
cld notebooks ls Docs:betrieb            # child notes
cld notebooks tree Docs                  # the whole tree
cld notebooks tags Docs --json
cld notebooks backlinks <note> --json
cld notebooks graph Docs
```

Search covers every accessible notebook unless `--notebook` narrows it. `--tags` is comma-separated and all tags must match. Time filters are `--created-after`, `--created-before`, `--updated-after`, and `--updated-before` with ISO timestamps. Results include the notebook so the next command can use the note ID directly.

## Named blocks

Named blocks let an agent address structured Markdown without rewriting the rest of the note. `cat --json` lists discovered blocks; `cat --block <name>` returns one block with a stable hash.

```bash
block_json="$(cld notebooks cat <note> --block status --type data --json)"
block_hash="$(printf '%s' "$block_json" | jq -r '.block.hash')"

cld notebooks edit <note> --replace-block status --type data --if-block-hash "$block_hash" --from - <<'MD'
:::data
state: ready
owner: ops
:::
MD
```

Supported block types are `table`, `list`, `data`, `section`, and `unknown`. A handle above anything else, such as a callout or a paragraph, has the type `unknown` and covers only the next line: `cat --block` returns nothing, and `--replace-block` replaces just that line. Do not edit such a block; name the surrounding heading instead. A name may occur more than once; select a duplicate with `--index`. For data blocks, `cat --block` returns the inner data text, but `--replace-block` replaces the whole block including its delimiters and keeps `@status` unless `--include-handle` is set. Include the `:::data` lines in the replacement.

## Attachments, versions, and exports

```bash
cld notebooks attach <note> ./diagram.png          # prints ![diagram.png](attach://Ab12Cd)
cld notebooks attachments list Docs --json
cld notebooks attachments download Docs Ab12Cd --out ./diagram.png
cld notebooks attachments delete Docs Ab12Cd --yes
cld notebooks versions list <note> --json
cld notebooks versions cat <note> <version-id>
cld notebooks versions restore <note> <version-id> --into <empty-note>
cld notebooks templates
cld notebooks create "Team handbook" --template <template-id>
cld notebooks export Docs --out ./docs.zip
```

`attach` uploads a file to the note's notebook and prints a ready-to-paste Markdown link; paste it with `edit` or into a mirror file. Attachments belong to the notebook, so `attach Docs: ./file.pdf` works without a note. `attachments delete` shows how many notes link the file before it asks. A version restore needs an existing empty target note, so the current note is never overwritten. The ZIP export is portable notebook data; keep it secure.

## Access, API keys, and snapshots

```bash
cld notebooks access list Docs --json
cld notebooks access search-principals "operations" --kind group --json
cld notebooks access grant Docs --group <group-id> --permission write --json
cld notebooks access grant Docs --service-account "Release agent" --permission write --json
cld notebooks access set Docs --group <group-id> --permission read --json
cld notebooks access revoke Docs --access-id <access-id> --yes
cld notebooks api-keys create Docs automation --permission write --json
cld notebooks api-keys list Docs --json
cld notebooks api-keys revoke Docs <key-id> --yes
cld notebooks snapshots show Docs
cld notebooks snapshots set Docs --enabled true --endpoint https://s3.example.com --region eu-central-1 --bucket backups \
  --access-key-id "$ACCESS_KEY" --secret-access-key "$SECRET_KEY"
cld notebooks snapshots run Docs
cld notebooks snapshots logs Docs --json
```

Permissions are `read`, `write`, or `admin`. `--service-account` takes a service account ID or exact name, and `search-principals --kind service_account` finds standalone and agent accounts. The `access list` table shows their grants, with type `agent` for agents, and hides grants of resource-bound service accounts behind notebook API keys unless you pass `--include-service-accounts`, which lists them with type `resource-bound`. An agent account with a grant lists, reads, and writes notes under its own identity like a person with the same grant; its token's scopes cap that grant. Creating notebooks, comments, favorites, and access or API-key management stay limited to people. The token from `api-keys create` is shown once; store it in the intended secret manager and never in a note or log. Snapshot reads are redacted; pass secrets through shell variables, not literals.

## Command reference

All commands support the global options `--json`, `--profile`, `--server`, and `--token`. Run `cld notebooks <command> --help` for flags.

| Command | Purpose |
|---|---|
| `ls [<notebook>[:<path>]]` | Notebooks, or the children of a notebook or note; `--q <text>` filters notebooks by name or description, `--page` and `--per-page` page them. |
| `tree <notebook>[:<path>]` | Note tree. |
| `cat <note>` | Live content; `--json`, `--numbered`, `--blocks`, `--block <name>`. |
| `stat <note>` / `stat <notebook>:` | Metadata. |
| `search [query]` | Full-text, tag, and time search; `--notebook` narrows it. |
| `write <note>` | Replace content or create the note; `--from`, `--content`, `--parents`, `--if-content-hash`. |
| `edit <note>` | One precise edit with preconditions and `--dry-run`. |
| `preview <note>` | Validate query and TOC blocks of the saved page or a draft. |
| `mv <note> <target>` | Move and/or rename. |
| `cp <note> <notebook>[:<path>]` | Copy into another notebook. |
| `rm <note>` | Delete with children; confirmation or `--yes`. |
| `lock <note>` | Permanent lock; confirmation or `--yes`. |
| `attach <note> <file>` | Upload and print a Markdown link. |
| `pull [<notebook>] <dir>` | Download a notebook as a Markdown mirror; `--force`. |
| `tags`, `backlinks`, `graph` | Tags, incoming links, link graph. |
| `create <name>` | Empty notebook, or `--template <id>`. |
| `templates`, `update`, `delete`, `export` | Notebook templates, settings, deletion, ZIP export. |
| `comments list\|add\|update\|delete` | Note discussion. |
| `versions list\|cat\|restore` | Note history. |
| `attachments list\|download\|delete` | Notebook files. |
| `favorites list\|add\|remove` | Your favorite notes. |
| `api-keys list\|create\|revoke` | Notebook-bound API keys. |
| `snapshots show\|set\|logs\|run` | S3 snapshots. |
| `access list\|grant\|set\|revoke\|search-principals` | Direct access grants. |

## JSON contracts

Treat JSON fields as the contract and tolerate additional fields.

- `ls` without a notebook returns `{ data: Notebook[], pagination }`. With a notebook it returns `{ notebook: { id, name }, parentId, data: [{ id, title, hasChildren, updatedAt }] }`. `tree` returns the same with nested `children`.
- `search`, `versions list` return `{ data, pagination }`; continue with `--page` while `pagination.has_next` is true. Search hits are `{ note, notebook: { id, name }, snippet }`.
- `cat --json` returns `{ note, content, contentHash, lineCount, blocks: [{ name, type, line, startLine, endLine, hash }] }`; `cat --block --json` returns `{ note, block: { name, type, index, startLine, endLine, hash, content } }`.
- `write --json` returns `{ action: "created" | "updated" | "unchanged", note, contentHash, mirrorPath? }`. `edit --json` returns `{ note, content, changed, beforeHash, afterHash, blocks, mirrorPath? }`. `mv --json` returns `{ note, mirrorPath? }`.
- `pull --json` returns `{ root, notebook, notes, written, removed, kept: [{ path, reason }], attachments: { downloaded, removed } }`. Reasons are `local-changes`, `changed-on-both-sides`, `deleted-on-server`, and `path-occupied`.
- `attach --json` returns `{ attachment, markdown }`.
- Errors in `--json` mode are printed to stderr as `{ "error": { "message", "status", "exitCode" } }`.

## Further references

Load only the reference needed for the task:

- [Notebook Markdown](markdown.md): read before writing or restructuring note content. It lists every supported block with an example.
- [Table formulas](formulas.md): read when creating or changing formulas inside Markdown tables.

These references list the supported syntax and functions. Do not assume that anything unlisted exists.
