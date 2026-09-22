# CLI plugins

## What plugins are

Built-in Cloud apps ship their commands inside `cld`. Other Cloud apps ship them as `cld` plugins: packages that add one command module, such as `cld inventory …`, to the installed `cld` without a new `cld` release.

A plugin runs inside `cld`, unsandboxed, with the user's Cloud credentials. Install or remove one only when the user asks for that exact package or path.

## Inspect installed plugins

```bash
cld plugins list
cld plugins list --json
cld help
```

`cld plugins list` shows each plugin's ID, package, version, source, and status. `ok` means its commands are available. `shadowed` means a newer built-in command with the same name wins for `cld <id>`; run the plugin with `cld plugins run <id> …`. `incompatible` means the plugin needs a different plugin API version. `error` means the manifest or entry is invalid or fails to load. `cld help` lists the working plugin modules and prints one stderr warning for each skipped plugin; a broken plugin never affects built-in commands.

## Run plugin commands

Plugin commands run as `cld <id> …`. `cld plugins run <id> …` runs the same commands and always reaches the plugin, even when a built-in command shadows it:

```bash
cld inventory items list --json
cld plugins run inventory items list --json
```

## Install and remove

```bash
cld plugins install @example/inventory-cli@1.4.0
cld plugins install ./inventory-cli-1.4.0.tgz
cld plugins install ./path/to/plugin-directory
cld plugins remove inventory
```

`install` accepts an npm package from the public registry (exact version or dist-tag, default `latest`, integrity-checked), a local `.tgz` archive, or a local directory. It prints the package, version, and source and asks for confirmation; without a terminal it requires `--yes`. Pass `--yes` only after the user confirmed that package, version, and source. Installing the same ID again replaces it. IDs of built-in modules and top-level commands are reserved, and `install` refuses them. For a private registry, run `npm pack <package>` and install the resulting `.tgz`.

Plugins live in `~/.config/cloud/cld/plugins/<id>/` (under `$XDG_CONFIG_HOME` when set).
