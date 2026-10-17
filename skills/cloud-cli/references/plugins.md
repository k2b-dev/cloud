# CLI plugins

## What plugins are

Every Cloud app serves its `cld` commands as a plugin, the built-in apps included; `cld` itself only signs in, manages profiles and plugins, and updates. `cld plugins install <name>` downloads one from the current profile's Cloud, verifies every file's SHA-512, and locks that version for the profile. Package plugins (a local path, a `.tgz`, or `npm:<package>`) carry commands and references for every profile. Both sources use the same verified bundle and content-addressed store.

A plugin runs inside `cld`, unsandboxed, with the user's Cloud credentials.

## Inspect plugins

```bash
cld plugins list
cld plugins list --all --json
cld help
```

`cld plugins list` shows, per profile, each plugin's app, installed and available version, status, and source. `available` means the Cloud serves it and it is not installed; `update available` means the Cloud serves another version; `not served` means the Cloud no longer serves an installed plugin; `unknown` means the Cloud could not be reached. Package plugins show profile `*` and `ok`, `shadowed`, `incompatible`, or `error`. `incompatible` means an old-format directory whose author must re-pack it; `error` means a package record points to a missing store entry and must be reinstalled from its recorded source. `cld help` lists the active modules for the current profile.

The SHORT NAMES column shows aliases and shortcuts, with `(inactive)` for conflicts or a missing served list; JSON rows include `alias` (string or null), `shortcuts` (object, empty when none), and `inactive` (list of names). `cld plugins list` also refreshes the saved list of served modules, so a short name stops taking the name of a module the Cloud started serving.

`cld help` shows active short names such as `assistant (ai)` and lists command shortcuts. Agents use the full module name in commands they run or write down.

## Install, update, and remove

```bash
cld plugins install mail
cld plugins install --all
cld plugins update
cld plugins update --all
cld plugins remove mail
```

A command whose plugin is missing fails with `run cld plugins install <name>`: install it when the user's task needs that module. `update` covers every plugin of the current profile (or the one `--profile` names); `update --all` covers every profile, also with `--profile`. A `cld: <profile>: <reason>` line means only that profile failed, for example because it cannot sign in; the other profiles still update and the command exits with 1. Tell the user the reason instead of retrying. A release that ships the same files under a new version only refreshes the version label. `cld login` offers the Cloud's plugins after signing in (`--yes` installs them, `--no-plugins` skips).

A `403` means the operator allows plugins only for full accounts; tell the user instead of retrying.

## Read a module's reference

```bash
cld mail reference
cld mail reference compose.md
```

`reference` works for every installed module, including package plugins. It prints the entry page; a file argument prints one of the files it links to. An unknown file lists the available ones. The same files are in this skill under `references/<module>/<version>/`; the table in `SKILL.md` shows Profile (`*` for package plugins), Module, Version, Summary, and Start. Open the Start file for the module and profile you operate.

Readable resource objects in JSON/JSONL output carry `permalink`, an absolute
`/open/<type>/~<encoded-id>` link on the selected profile's server; the `~` prefix
is required. Share supplied links without building URLs. Generic capability
commands also make provider semantic `links[].href` absolute. The link opens
the resource for anyone who may read it; Core checks access when it is followed.
Published Grids app commands add no permalinks, because a published app can show
records to people without access to the Base.

## Skill targets

```bash
cld skills list
cld skills add ~/.claude/skills
cld skills sync
```

`cld` rewrites this skill in every target after each plugin change and each `cld update`. Add a target only when the user asks for it. When `cld` reports that no skill target was chosen, tell the user; `cld skills sync --yes` writes the default `~/.agents/skills` only after they agree.

## Package plugins

```bash
cld plugins install npm:@example/inventory-cli@1.4.0
cld plugins install ./inventory-cli-1.4.0.tgz
cld plugins install ./path/to/plugin-directory
cld plugins run inventory items list --json
cld plugins remove inventory
```

Install or remove a package plugin only when the user asks for that exact package or path. `cld` prints the package, version, source, module name, and reference count and asks for confirmation; without a terminal it requires `--yes`. The confirmation says it runs inside `cld` with the user's Cloud credentials. Pass `--yes` only after the user confirmed them. `cld plugins run <name> …` always reaches a plugin, even when a built-in command shadows it.

Update a package plugin by installing the new package again with `cld plugins install <source>`. Authors pack it with `bun run node_modules/@k2b/cloud/scripts/cli-pack.ts`; old packages are refused. Remove an old-format directory with `cld plugins remove <id>`.

Plugins live in `~/.config/cloud/cld/plugins/` (under `$XDG_CONFIG_HOME` when set). Both sources use `store/<digest>/`; global package records are in `packages.json`. Package install and removal rewrite the skill and its references automatically.
