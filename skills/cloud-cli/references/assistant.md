# Assistant CLI

Use `cld assistant` for interactive access to the user's personal Cloud agent and for chat automation. Assistant is the CLI and GUI surface for personal conversations stored by Cloud AI Core; chats started from Mail or another application appear in the same history. The root command starts or continues a chat, while named management commands inspect chat state and files, resolve pending actions, manage personalization, and manage Projects.

## Interactive and print modes

Start a line-oriented terminal session:

```bash
cld assistant
cld assistant "Summarize my open work"
cld assistant --chat <chat-id>
```

The startup line shows the effective model. New chats print their stable resume command, and the CLI repeats it when the session ends. Blue `Info:` messages confirm non-error state changes. The interactive commands are deliberately small: `/help`, `/exit`, `/attach`, `/files`, and `/model`. Run `/model` without an argument to choose from the visible options by number. A selected model remains active for the session.

Enable local computer access explicitly:

```bash
cld assistant --allow-bash
```

This adds the predefined `local_bash` client tool only to turns from that
interactive session. The CLI prints the exact command and startup directory and
requires `Y/n` before every execution. It runs `/bin/bash` as the current OS
user with closed stdin, a fixed timeout, and bounded stdout/stderr. Tool calls
and results are stored in Cloud and remain visible in web chat history. The web
app cannot execute them. Do not use this mode for untrusted prompts without
reviewing each command carefully.

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

Useful options:

- `--title <title>` names a newly created chat.
- `--model <profile-id>` selects a model from `cld assistant models`.
- `--project <project-id>` creates the new chat in an accessible Project.
- Repeat `--attach <local-file>` for local images or documents. This flag does not accept a Cloud resource ID.
- `--detach` submits the turn and returns its ID without waiting in print mode.
- Repeat `--approve <exact-tool-name>` in print mode to approve only those tools for that turn. There is deliberately no approve-all flag.

Print mode writes assistant text to stdout and tool progress to stderr. `--json` waits and prints one final aggregate. `--jsonl` emits versioned stream events such as text deltas, tool state changes, attention requests, and turn completion. Structured output, detached submission, and piped input require `--print`.
`--allow-bash` is deliberately rejected with `--print`, structured output, and
detached execution.

The web composer and CLI share one durable conversation draft. Before a CLI turn in an existing chat, the CLI refuses to replace a non-empty unsent web draft. Send or clear that draft in Assistant, then retry the CLI command. This prevents a terminal turn from silently overwriting text, files, or Cloud resources prepared in another tab.

If a turn needs an approval or frontend tool result that was not supplied, the command exits with status `2`. Inspect and resolve it explicitly:

```bash
cld assistant actions list <chat-id> <turn-id>
cld assistant actions approve <chat-id> <turn-id> <call-id>
cld assistant actions reject <chat-id> <turn-id> <call-id>
cld assistant actions submit <chat-id> <turn-id> <call-id> --result-file result.json
cld assistant turns watch <chat-id> <turn-id>
```

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

## Scheduled chat tasks

Tasks store a prompt that is delivered back into one Assistant chat. They are
not directly attached to Projects; a chat in a Project loads current Project
context when the task runs. One-time `--at` values are local wall-clock times
in `app.timezone`, with the exact format `YYYY-MM-DDTHH:mm`. Recurring tasks use
a five-field cron expression in the same timezone.

```bash
cld assistant tasks list
cld assistant tasks status
cld assistant tasks list --chat <chat-id> --state active
cld assistant tasks get <task-id>
cld assistant tasks create --chat <chat-id> --prompt "Check the release" --at 2026-08-12T09:30
cld assistant tasks create --chat <chat-id> --prompt-file ./weekly-review.md --cron "0 9 * * 1"
cld assistant tasks update <task-id> --at 2026-08-13T10:00
cld assistant tasks pause <task-id>
cld assistant tasks resume <task-id>
cld assistant tasks run <task-id>
cld assistant tasks delete <task-id> --yes
```

Use `tasks status` before creating a schedule when you need to confirm the
effective application timezone. `tasks get` includes recent occurrence history. A terminal delivery or turn
failure moves the task to `needs_attention`. Resume a recurring task after
fixing the cause; a failed one-time task needs a new future schedule via
`tasks update`. Deleting a task deletes its history, and deleting its chat cascades
to the task and all occurrences.

## Conversation files

Conversation uploads under `/input` represent immutable user inputs. Files under `/files` are the editable agent workspace.

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

Personalization use and learning from chats are separate settings. Learning considers only genuine user-authored text, not attached Cloud resources, files, tool results, scheduled prompts, inter-chat deliveries, or Assistant output:

```bash
cld assistant personalization status
cld assistant personalization configure --use on
cld assistant personalization configure --learning on
cld assistant personalization configure --use off --learning off
```

## Projects

Projects combine shared instructions, knowledge, files, Cloud references, model defaults, and Cloud access grants. Chats created in a Project remain private.

```bash
cld assistant projects list
cld assistant projects create "Release notes" --instructions-file ./release-notes.md
cld assistant projects knowledge add "Release notes" "Editorial guidelines" --content-file ./guidelines.md
cld assistant projects files put "Release notes" ./glossary.csv
cld assistant projects references add "Release notes" grids.record <record-id> --label "Current catalog"
cld assistant projects access grant "Release notes" <group-id> --type group --permission write
cld assistant chats create --project <project-id>
```

Project names and short IDs are accepted by management commands. Access grants use `read`, `write`, or `admin`; the Project owner is always an administrator.

Run `cld assistant <group> help` or `cld assistant <group> <command> --help` for the complete accepted flags.
