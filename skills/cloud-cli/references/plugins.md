# CLI plugins

## What plugins are

Every Cloud app serves its `cld` commands as a plugin, the built-in apps included; `cld` itself only signs in, manages profiles and plugins, and updates. `cld plugins install <name>` downloads one from the current profile's Cloud, verifies every file's SHA-512, and locks that version for the profile. Package plugins (a local path, a `.tgz`, or `npm:<package>`) add commands for every profile, for development or for commands no Cloud serves.

A plugin runs inside `cld`, unsandboxed, with the user's Cloud credentials.

## Inspect plugins

```bash
cld plugins list
cld plugins list --all --json
cld help
```

`cld plugins list` shows, per profile, each plugin's app, installed and available version, status, and source. `available` means the Cloud serves it and it is not installed; `update available` means the Cloud serves another version; `not served` means the Cloud no longer serves an installed plugin; `unknown` means the Cloud could not be reached. Package plugins show profile `*` and `ok`, `shadowed`, `incompatible`, or `error`. `cld help` lists the modules that are installed for the current profile.

## Install, update, and remove

```bash
cld plugins install mail
cld plugins install --all
cld plugins update
cld plugins update --all
cld plugins remove mail
```

A command whose plugin is missing fails with `run cld plugins install <name>`: install it when the user's task needs that module. `update --all` covers every profile. `cld login` offers the Cloud's plugins after signing in (`--yes` installs them, `--no-plugins` skips).

A `403` means the operator allows plugins only for full accounts; tell the user instead of retrying.

## Read a module's reference

```bash
cld mail reference
cld mail reference compose.md
```

`reference` prints the plugin's entry page; a file argument prints one of the files it links to. An unknown file lists the available ones. The same files are in this skill under `references/<module>/<version>/`; the table in `SKILL.md` names the folder for each profile and module.

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

Install or remove a package plugin only when the user asks for that exact package or path. `cld` prints the package, version, and source and asks for confirmation; without a terminal it requires `--yes`. Pass `--yes` only after the user confirmed them. `cld plugins run <name> …` always reaches a plugin, even when a built-in command shadows it.

Plugins live in `~/.config/cloud/cld/plugins/` (under `$XDG_CONFIG_HOME` when set): package plugins in `<id>/`, served plugins in `store/<digest>/`.
