---
title: Application CLI modules
navTitle: CLI modules
section: Platform services
order: 595
description: Expose application operations through the shared cld command-line interface.
tags: [cli, cld, automation, plugins]
updated: 2026-09-22
---

# Application CLI modules

Add a CLI module when a server operation should also be available through
`cld`.

The shared CLI owns profiles, sign-in, server selection, global output flags,
and help. An application module owns its commands and calls the same HTTP API
as every other client.

## Select a locale

`cld` resolves one locale per invocation. Pass `--locale <BCP-47-tag>` before
the module name, or set `CLD_LOCALE`; the explicit flag wins and the
deterministic default is `en`. Regional tags use normal ancestor fallback, so
`de-CH` uses German CLI text when no Swiss German message exists.

The resolved tag is available as `ctx.options.locale` and is sent as
`Accept-Language` with every authenticated application request. This keeps
server-owned API messages aligned with the CLI without process-global locale
state. For application-owned text, use `cliText(ctx, { en, de })` at the final
`ctx.print()` or `ctx.error()` boundary.

Command names, flags, argument names, examples, IDs, enum values, error codes,
and technical product terms are stable CLI syntax and stay unchanged. JSON and
JSONL payloads are machine contracts and are never translated. The bundled
CLI localizes its shell help, authentication flow, profile status, and
server-owned human messages. Application modules own their command descriptions
and table headings. Localize them with explicit catalog keys, not by inspecting
or replacing English output strings.

The CLI passes the resolved locale to a module's optional `help(locale)` callback
for root help. A module that builds localized command definitions should use
that locale for `help` and `ctx.options.locale` for `run`. Existing callbacks
without a locale argument remain valid.

```ts
import { cliText } from "@k2b/cloud/cli";

if (ctx.options.output === "text") {
  ctx.print(cliText(ctx, { en: "Saved.", de: "Gespeichert." }));
}
```

## Define a module

Build a module with `defineCliCommands()` and `command()`:

```ts
import {
  arg,
  command,
  defineCliCommands,
  printStructured,
} from "@k2b/cloud/cli";

export default defineCliCommands({
  name: "inventory",
  summary: "Manage inventory items.",
  requiresCloud: true,
  commands: [
    command("items get", {
      summary: "Show one inventory item",
      args: {
        item: arg.required({ description: "Item ID" }),
      },
      async run({ ctx, args }) {
        const item = await ctx.readJson<{
          id: string;
          name: string;
          quantity: number;
        }>(
          await ctx.fetch(
            `/api/inventory/items/${encodeURIComponent(args.item)}`,
          ),
        );

        if (printStructured(ctx, item)) return;
        ctx.print(`${item.name} (${item.quantity})`);
      },
    }),
  ],
});
```

The command path is relative to the module. This example runs as:

```sh
cld inventory items get <item-id>
```

Multi-word command paths create command groups automatically. Give those
generated groups concise summaries so root and subtree help explains their
purpose:

```ts
export default defineCliCommands({
  name: "inventory",
  summary: "Manage inventory items.",
  groupSummaries: {
    items: "Inspect and manage inventory items",
    "items stock": "Review and adjust item stock",
  },
  commands: [
    command("items list", { summary: "List inventory items", run: listItems }),
    command("items stock get", { summary: "Show current stock", run: getStock }),
  ],
});
```

Keys are command paths relative to the module. Only generated group paths are
accepted; leaf commands already use their own `summary`.

`defineCliCommands()` rejects duplicate paths and dispatches the longest
matching command path.

Use `command("")` when the module itself has a primary operation. Named
commands still take precedence; other positional input goes to the root
command:

```ts
export default defineCliCommands({
  name: "assistant",
  summary: "Chat and manage Assistant.",
  commands: [
    command("", {
      summary: "Chat with Assistant",
      args: { prompt: arg.rest() },
      flags: {
        print: flag.boolean({ aliases: ["p"] }),
      },
      run: ({ args, flags }) => runChat(args.prompt, flags.print),
    }),
    command("status", {
      summary: "Show status",
      run: showStatus,
    }),
  ],
});
```

This supports both `cld assistant` and `cld assistant -p "Hello"` without an
application-specific dispatcher. Reserve named command prefixes for management
operations; for example, `cld assistant status` still selects `status`.

`requiresCloud` defaults to true. Set it to false only for a module that can
run without a server profile or token. A mixed module may instead set
`requiresCloud: false` on one `command()` that only reads local input. The CLI
then skips profile and token requirements for that command while every other
command in the module keeps its normal Cloud gate. An offline command must not
call `ctx.fetch()`.

## Define arguments and flags

Arguments are positional and read in declaration order.

| Builder | Value in `run()` | Use |
| --- | --- | --- |
| `arg.required()` | `string` | Required value |
| `arg.optional()` | `string \| undefined` | Optional value |
| `arg.rest()` | `string[]` | Remaining values |

Flags are named and typed:

| Builder | Value in `run()` | Options |
| --- | --- | --- |
| `flag.string()` | `string \| undefined` | `required`, `default`, aliases |
| `flag.boolean()` | `boolean` | `default`, aliases |
| `flag.int()` | `number \| undefined` | `required`, `default`, `min`, `max` |
| `flag.enum(values)` | One allowed value or `undefined` | `required`, `default` |
| `flag.stringList()` | `string[]` | `separator`, `default` |
| `flag.input()` | Input descriptor | Direct value, file, or stdin |

Every flag also accepts `name`, `aliases`, `description`, and `valueLabel`.
Object keys use kebab case by default, so `perPage` becomes `--per-page`.

Use the shared presets for common behavior:

```ts
flags: {
  ...paginationFlags({ defaultPerPage: 50, maxPerPage: 200 }),
  yes: confirmFlag(),
}
```

`paginationFlags()` adds `--page` and `--per-page`. `confirmFlag()` adds
`--yes`. A destructive command must still reject the operation when `yes` is
false.

## Read input

`flag.input()` lets one command accept a direct value, a file, or stdin:

```ts
flags: {
  body: flag.input({
    description: "JSON payload, a file, or stdin",
    required: true,
  }),
},
async run({ ctx, flags }) {
  const body = await readCliInput(flags.body, {
    label: "inventory JSON",
    required: true,
  });
  // Send body to the server.
}
```

For a flag named `body`, the user can pass one of:

```sh
cld inventory items import --body '{"name":"Cable"}'
cld inventory items import --body-file ./items.json
cat items.json | cld inventory items import --stdin
```

Set `stdinName: false` when stdin is not valid. `readCliInput()` can also remove
one final newline with `trimFinalNewline: true`.

`flag.input()` also accepts `fileName` and `fileAliases`. Its value contains
`source`, `value`, `file`, and `provided`; pass that value to
`readCliInput()` instead of opening files or reading stdin yourself.

## Support every output mode

Every command must keep stdout valid for the selected mode:

| Mode | Contract |
| --- | --- |
| Text | Human-readable output |
| `--json` | One JSON value |
| `--jsonl` | One compact JSON value per line |

Use `printStructured()` before custom text:

```ts
if (printStructured(ctx, item)) return;
ctx.print(`${item.name} (${item.quantity})`);
```

Do not call `ctx.json()` for both structured modes. It pretty-prints JSON and
does not satisfy the JSONL contract.

Use `printRows()` for lists:

```ts
printRows(
  ctx,
  page,
  page.items,
  [
    { key: "id", label: "ID" },
    { key: "name", label: "NAME" },
    { key: "quantity", label: "QUANTITY" },
  ],
);
```

Structured output receives the full `page`. Text output receives the table
projection. Write progress and warnings with `ctx.error()` so stdout remains
machine-readable.

Global output flags work before or after the command arguments:

```sh
cld --jsonl inventory items list
cld inventory items list --jsonl
```

## Use the command context

`CloudCliContext` provides:

| API | Use |
| --- | --- |
| `fetch()` | Authenticated request to the selected Cloud server |
| `readJson()` | Checked JSON response |
| `createApiClient()` | Typed Hono client for an application API |
| `print()` | One text line on stdout |
| `write()` | Raw stdout chunk |
| `error()` | One stderr line |
| `json()` | One JSON value |
| `jsonLine()` | One compact JSON value |
| `table()` | Text table |
| `getDefault()` / `setDefault()` | Profile-scoped application defaults |

`readJson()` accepts native fetch responses and typed Hono client responses.
It requires `json()`, `text()`, `ok`, `status`, and `statusText`.

Use this context. Do not read CLI token or profile files from an application
module.

## Add access commands

Use `createAccessCommands()` when a resource exposes direct grants. It adds:

```text
access list
access grant
access set
access revoke
access search-principals
```

Provide an `AccessCommandAdapter` that resolves the application resource and
calls its access API:

```ts
const accessAdapter: AccessCommandAdapter<ItemResource> = {
  resourceLabel: "item",
  allowedPermissions: ["read", "write", "admin"],
  allowServiceAccounts: true,
  resolveResource,
  list,
  grant,
  update,
  revoke,
};

const commands = [
  itemsList,
  itemsGet,
  ...createAccessCommands(accessAdapter),
];
```

The adapter accepts:

| Option | Required | Use |
| --- | --- | --- |
| `resourceLabel` | Yes | Resource name used in help and output |
| `resolveResource` | Yes | Resolve the optional resource arguments |
| `list`, `grant`, `update`, `revoke` | Yes | Call the resource's access API |
| `allowedPermissions` | No | Limit grants; defaults to `read`, `write`, and `admin` |
| `allowPublic` | No | Add public-principal commands; defaults to `false` |
| `allowServiceAccounts` | No | Add service-account commands; defaults to `false` |
| `resourceArgLabel` | No | Value label shown for resource arguments |
| `resourceArgDescription` | No | Help text for resource arguments |
| `examples` | No | Examples for each generated access command |

Public grants and service-account grants are disabled unless the adapter
explicitly enables them. Principal search uses the same Accounts endpoint as
`PermissionEditor`.

The CLI package also exports the helpers used by the generated commands:

| Helper | Use |
| --- | --- |
| `listAccessPrincipalEntities()` | Search users, groups, and optional service accounts |
| `resolveAccessPrincipal()` | Validate one principal flag and resolve it to a `Principal` |
| `printAccessEntries()` | Render grants in text, JSON, or JSONL |

Use them when an application needs a different command shape. Keep the same
principal resolution and output contracts.

## Register the module

Export the module from the application package, usually from `src/cli.ts`.

The bundled `cld` distribution imports the built-in modules explicitly. Every
other application ships its module as a `cld` plugin. The installed `cld`
loads plugins at run time, so the application releases its commands on its
own schedule, without a new `cld` build.

## Ship a module as a plugin

A plugin is an npm package, a `.tgz` archive of one, or a local directory
with a `package.json` that declares the plugin manifest:

```json
{
  "name": "@example/inventory-cli",
  "version": "1.4.0",
  "type": "module",
  "files": ["dist"],
  "cld": {
    "apiVersion": 1,
    "entry": "dist/cli.js"
  }
}
```

| Field | Rule |
| --- | --- |
| `name`, `version` | Required. Shown by `cld plugins list`. |
| `cld.apiVersion` | Required. `1` is the `CloudCliModule` contract of `@k2b/cloud/cli`. |
| `cld.entry` | Required. Relative path to an ESM file inside the package. |

The entry's default export is the module from `defineCliCommands()`. Its
`name` becomes the command, `cld inventory …`, and the plugin's ID.

The names of built-in modules and top-level commands (`help`, `version`,
`login`, `logout`, `auth`, `profile`, `update`, `plugins`) are reserved.
`cld plugins install` refuses a plugin whose ID matches one of them. Choose a
distinct ID, such as your application ID.

Bundle the entry into one self-contained file. `cld` does not install plugin
dependencies, so the bundle carries its own copy of `@k2b/cloud/cli`:

```sh
bun build src/cli.ts --target bun --format esm --outfile dist/cli.js
```

`cld` checks the module's shape, not its package copy. Any `@k2b/cloud`
version that produces the `apiVersion: 1` module shape works.

Release the plugin package together with the application. Command names,
flags, and JSON output stay stable syntax across plugin versions.

## Install a plugin

```sh
cld plugins install @example/inventory-cli@1.4.0
cld plugins install ./inventory-cli-1.4.0.tgz
cld plugins install ./packages/inventory-cli
cld plugins list
cld plugins run inventory items get <item-id>
cld plugins remove inventory
```

`install` accepts a local directory, a local `.tgz` archive, or an npm package
from the public npm registry. Pass an exact version or a dist-tag; the
default is `latest`. `cld` checks the tarball against the registry's `sha512`
integrity value. To install from a private registry, download the archive
with `npm pack <package>` and install the `.tgz` file.

Before it places a plugin, `cld` checks the manifest and shows the package,
version, and source. It asks for confirmation unless you pass `--yes`, and
without a terminal it requires `--yes`. It then loads the module and installs
it under `$XDG_CONFIG_HOME/cloud/cld/plugins/<id>/`; without
`XDG_CONFIG_HOME`, that is `~/.config/cloud/cld/plugins/<id>/`.
Installing the same ID again replaces it. You can also place an unpacked
plugin directory there by hand; `cld plugins list` shows its source as
`manual`.

`cld plugins list` shows each plugin's ID, package, version, source, and
status:

| Status | Meaning |
| --- | --- |
| `ok` | The plugin loads and its commands are available. |
| `shadowed` | A later `cld` release added a built-in command with the same name. It takes precedence for `cld <id>`; run the plugin with `cld plugins run <id>`. |
| `incompatible` | The manifest names a plugin API version that this `cld` does not support. |
| `error` | The manifest, the entry, or the module is invalid, or the entry fails to load. |

A plugin's commands run as `cld <id> …`. `cld plugins run <id> …` runs the same
command tree and always reaches the plugin, even when it is shadowed, so a new
built-in command never makes an installed plugin unreachable. Use it in
scripts that must keep working across `cld` upgrades.

`cld help` lists plugin modules next to the built-in modules and prints one
warning line on stderr for each plugin that it skips. A broken plugin fails
only its own commands. Built-in commands never load plugins.

## Plugin security

A plugin is not sandboxed. It runs inside `cld` with the permissions of your
operating-system account and receives the same `CloudCliContext` as a
built-in module: the selected profile, the Cloud credentials, the locale, and
the output mode. Plugins do not get extra privileges or access to other
plugins through `cld`, but their code can read any file that you can read.

Install plugins only from sources that you trust, and pin a version for
repeatable installations. Cloud authorizes plugin requests exactly like other
requests from the same user. The server remains the only place that grants
access.

## Keep authorization on the server

A CLI command is an API client. It must call authenticated routes and receive
the same authorization result as the browser or another integration.

Keep domain writes and permission checks on the server. The command should only
parse input, call the API, and render the result.

See [Typed HTTP APIs](/en/docs/server/http),
[Resource authorization](/en/docs/identity/authorization), and
[Resource API keys](/en/docs/identity/resource-api-keys).
