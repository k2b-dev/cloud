---
name: cloud-cli
description: Use the Cloud CLI (`cld`) to work with a user's Cloud content from a terminal. Use this skill whenever an agent needs to use installed Cloud app commands, sign in or select a Cloud profile, choose safe CLI input/output, inspect Cloud API documentation, or complete Assistant, Contacts, FAQ, Files, Grids, Mail, Notebooks, Pulse, Spaces, or Tools workflows for the user.
---

# Cloud CLI

Cloud is a remote workspace platform, or Cloud OS, made of focused apps for work and daily operations. Each Cloud instance can publish a different set of apps to each user.

Use `cld` to work with the user's Cloud content from a terminal. It handles sign-in, the selected Cloud instance, command discovery, and structured output.

## Start

1. Install the app modules first: `cld plugins install --all`, or `cld plugins install apps <module>` for the one the task needs, with `apps` for step 3. Until then `cld` has no app commands and the [Installed modules](#installed-modules) table below is empty. `cld plugins list` shows what the Cloud serves and what needs an update.
2. If that reports no configured server or no sign-in, sign in with `cld login --server <Cloud URL>`, or with `--device` on a machine without a browser, such as a server reached over SSH, then install. Inspect or switch profiles with `cld profile list` and `cld profile use <name>`. Read [Sign-in and profiles](references/sign-in.md) for details.
3. Run `cld apps list --json` before choosing an app command. It shows the live Cloud apps available to the current user; use `--search <text>` to narrow the list.
4. Run `cld <app> reference`, then `cld <app> help` or `cld <app> <command> --help` for an unfamiliar operation. Help never runs a command, so `cld logout --help` or `cld profile set --help` is safe too. Every app module, built-in or third-party, is a `cld` plugin served by the Cloud; a missing one says `run cld plugins install <name>`.
5. Use the default profile unless the task names another instance; pass `--profile <name>` only when needed.

## How every `cld` module is organized

Modules share one command shape, so you can guess the basics before reading a reference; `cld <app> help` confirms it.

- **Verbs:** `ls` lists, `show` or `stat` shows metadata, `cat` prints content, `add` or `write` creates, `set` or `edit` changes, `mv` moves or renames, `cp` copies, `rm` deletes. Secondary resources sit in a plural group with `list`, `add`, `update`, and `delete`, such as `comments list`.
- **Addresses:** a resource argument takes its ID, `<container>:<path>` (container by ID or exact name), or, where the module keeps a local copy, a file path inside it. An ambiguous name fails with every candidate as `path (id)`; retry with one of the IDs. Nothing is guessed.
- **Flags:** `--json` on every command, `--yes` for destructive or irreversible actions, `--from <file|->` for content, `--out <path>` for downloads. A command exits `0` only when it did everything; otherwise `1`.

Each module's reference (`cld <app> reference`) remains authoritative for its exact commands, JSON shapes, and the content syntax the app accepts.

## Common tasks

Start with the reference named here; it holds the exact syntax and the safe workflow.

| Task | Start with |
| --- | --- |
| Write a note with callouts, tasks, tables, formulas, or data | `cld notebooks reference markdown.md`, then `cld notebooks write "<notebook>:<path>" --from note.md` |
| Change part of an existing note | `cld notebooks reference`, then `cld notebooks cat <note> --json` and `cld notebooks edit` |
| Upload a local file, create folders, or replace a file in Files | `cld filesv2 reference`, then `cld filesv2 put <local> <area>:/<folder>/ --parents` |
| Find a file when you do not know its area | `cld filesv2 reference`, section "Find a file in every area" |
| Put a spreadsheet or document (`.ods`, `.xlsx`, `.odt`, `.docx`) with content into Files | Build it locally first with LibreOffice; without it, build `.xlsx` and `.docx` with Python. `cld filesv2 reference` shows both. Then `cld filesv2 put` |
| Write or send mail | `cld mail reference compose.md` |
| Read or change table records and fields | `cld grids reference` and `cld grids reference schema.md` |
| Import a CSV file into a table, including Windows-1252 files, decimal commas, and `dd.mm.yyyy` dates | `cld grids reference`, section "Import a CSV file"; there is no CSV import command |
| Plan tasks in Spaces, write task descriptions and comments, or link a note or file to a task | `cld spaces reference` |
| Import or export contacts | `cld contacts reference` |
| Build a dashboard | `cld pulse reference dashboard-dsl.md` |

## Agent workflow

- Stay on the user's selected profile unless they name another Cloud instance.
- When you operate a headless box (SSH, container, CI runner) and `cld` is not signed in, run `cld login --server <Cloud URL> --device` and relay the printed URL and code to the user; they approve it in their own browser. Never ask the user for a password or token instead.
- When a profile was written by `cld admin agents create`, you act as that agent account, not as the user: `cld auth status` shows `client-credentials`. You see only what the agent was granted; ask the user to grant access instead of switching to their profile.
- Read before changing content. Use IDs returned by list or get commands when a name is not unique.
- Use `--json` whenever the next action depends on one complete response. Use `--jsonl` for supported list commands when processing items as a stream. Keep normal output for simple inspection.
- Before writing content into an app, such as a note, a message, a record, or a file, read that module's reference. Use only the syntax, commands, and flags it lists, and check flags with `cld <app> <command> --help`; what is not listed does not exist.
- Pass structured or multiline content through a command's file or stdin option instead of trying to escape it in a shell argument.
- File uploads such as `cld filesv2 put` and `cld notebooks attach` store the bytes as they are and convert nothing. Create a file in its final format locally with a tool available on the machine, then upload it.
- Ask the user for content you do not have, such as names, figures, or dates. Do not fill a note or file with invented data.
- Do not delete content, revoke access, or perform another destructive action without an explicit user request. Check command help for any required confirmation first.
- A plugin the user's Cloud serves may be installed with `cld plugins install <name>` when the task needs it. Install or remove a package plugin (path, `.tgz`, `npm:`) only when the user asks for that exact package or path; it runs unsandboxed with the user's Cloud credentials, so confirm the package, version, and source shown by `cld plugins install` before you pass `--yes`.

## References

Every module ships its own reference with the plugin. Run `cld <module> reference` for the module of the current task and read it before the first command; it links further files, which `cld <module> reference <file>` prints. Follow those links only when the operation needs the deeper API; do not preload every file.

- Read [Sign-in and profiles](references/sign-in.md) to sign in with a browser or a device code, keep several Cloud instances in profiles or remove one, store refresh tokens in fd0, and run as an agent account whose profile holds OAuth client credentials.
- Read [CLI plugins](references/plugins.md) to list, install, update, or remove `cld` plugins and to print their references.
- Run `cld apps reference` and `cld account reference` for the two modules every Cloud serves, `cld capabilities reference` for generic typed Queries and Actions, and `cld api-docs reference` for the live HTTP APIs.
- Administrators run `cld admin reference`, `cld accounts reference`, `cld oauth reference`, and `cld ipa-hosts reference` for the matching task.

## Installed modules

`cld` keeps this table current: every profile, the modules installed for it, their versions, and the folder with that version's references. Read the reference folder of the profile you operate; `cld <module> reference [file]` prints the same files.

<!-- cld:modules -->
No module is installed for any profile yet. `cld plugins install --all` installs the modules of the current profile's Cloud and fills this table.
<!-- /cld:modules -->
