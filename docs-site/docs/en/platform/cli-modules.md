---
title: Application CLI modules
navTitle: CLI modules
section: Platform services
order: 595
description: Expose application operations through the shared cld command-line interface.
tags: [cli, cld, automation, plugins]
updated: 2026-09-26
---

# Application CLI modules

Add a CLI module when a server operation should also be available through
`cld`.

The shared CLI owns profiles, sign-in, server selection, global output flags,
and help. An application module owns its commands and calls the same HTTP API
as every other client.

Asking for help never runs a command. `--help` or `-h` after the command,
`help` as its first or last argument, and `cld --help <command>` print the
usage of a built-in or module command and change nothing. `help` as the value
of a flag stays a value: `cld logout --profile help` signs out the profile
named `help`.

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
| `profiles?.saveClientCredentials()` | Store an OAuth client ID and secret as a client-credentials profile; absent in hosts without profiles |

`readJson()` accepts native fetch responses and typed Hono client responses.
It requires `json()`, `text()`, `ok`, `status`, and `statusText`.

`profiles` is optional. A command that provisions a machine credential, such
as `cld admin agents create`, hands the secret to `saveClientCredentials()`
and never prints it; the host stores it with the same protection as a refresh
token. Fail before any remote call when the capability is missing.

Use this context. Do not read CLI token or profile files from an application
module.

## Design commands

Every `cld` module uses the same verbs, addresses, and
flags, so a user or agent who knows one module can guess the basics of the
next one.

### Choose the verb

Name commands after what they do to the module's primary resource:

| Verb | Use |
| --- | --- |
| `ls` | List resources, optionally below a container or path |
| `show` or `stat` | Show metadata; use `stat` when the resource also has content |
| `cat` | Print a resource's content, such as Markdown or a file body |
| `add` or `write` | Create a resource; use `write` for content that can also replace an existing one |
| `set` or `edit` | Change fields with `set`; change content in place with `edit` |
| `mv` | Rename or move |
| `cp` | Copy |
| `rm` | Delete |

Put secondary resources in a group named by their plural noun, with the plain
verbs `list`, `add`, `update`, and `delete`: `comments list`, `versions
restore`, `access grant`. Keep domain operations that fit none of these as
their own verb, such as `pull`, `attach`, or `search`.

### Address resources

Every argument that names a resource accepts these forms:

| Form | Example | Resolution |
| --- | --- | --- |
| ID | `ns98Kq` | Always accepted and always unique |
| `<container>:<path>` | `"Team Docs":ops/backup` | Container by ID or exact name, then the path inside it |
| Local path | `./ops/backup.md`, `~/docs/a.md` | A file inside a local copy that the module manages, if it has one |

Parse the syntax with `parseCliAddress()` and resolve the result through the
application's own API. It returns `local` for arguments that start with `/`,
`./`, `../`, or `~`, `path` for `<container>:<path>` split at the first colon,
and `ref` for everything else.

Never guess. When a name or path segment matches several resources, the server
fails with `409 CONFLICT` and lists every candidate as `path (id)`. Build that
message with `cliAmbiguityText()` so every application reports ambiguity with
the same wording in English and German. An ID always resolves, so the user can
retry with one of the listed IDs.

A module that keeps local copies may add the ID to a file name when two
siblings share a name, for example `backup--Ab12Cd.md`. That suffix belongs
to local file names only; it is never path syntax on the server.

### Use the shared flags

| Flag | Contract |
| --- | --- |
| `--json` / `--jsonl` | Available on every command, with a stable documented shape; see [Support every output mode](#support-every-output-mode) |
| `--yes` | Required for destructive or irreversible actions; without a terminal, refuse instead of prompting |
| `--from <file\|->` | Read content from a file or stdin (`-`) |
| `--out <path>` | Write a download or export to a file instead of stdout |

### Exit with a clear status

A command exits with `0` when it did everything it was asked to do. Anything
else exits with `1`: a thrown error, an API error, or a partial result such as
skipped files. `cld` prints the error on stderr; with `--json`, it prints
`{"error":{"message","status","exitCode"}}` instead. Return `1` from `run()`
after you have printed a partial result.

### Localize the help

Write command summaries, descriptions, and messages in English and German.
Build the module in a function that takes the locale, use that locale for
`help`, and use `ctx.options.locale` for `run`. Command names, flags, and
examples stay unchanged.

### Example

This module lists and deletes inventory items. The item argument accepts an ID
or `<warehouse>:<path>`:

```ts
import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  cliAmbiguityText,
  command,
  confirmFlag,
  defineCliCommands,
  localizeCloudCliText,
  parseCliAddress,
  printRows,
  printStructured,
} from "@k2b/cloud/cli";
import { fail } from "@k2b/stdlib";

type Item = { [key: string]: unknown; id: string; name: string; path: string };

/** Server: a path segment that matches several items. */
export const ambiguousItem = (locale: string, segment: string, matches: Item[]) =>
  fail({
    code: "CONFLICT" as const,
    status: 409 as const,
    message: localizeCloudCliText(
      locale,
      cliAmbiguityText({
        value: segment,
        resources: { en: "items", de: "Artikeln" },
        candidates: matches.map((item) => ({ path: item.path, id: item.id })),
      }),
    ),
  });

const inventoryCommands = (locale?: string) => {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);

  const resolveItem = async (ctx: CloudCliContext, raw: string): Promise<Item> => {
    const address = parseCliAddress(raw);
    if (address.kind === "local")
      throw new Error(t({ en: `"${raw}" is a local path, not an item.`, de: `„${raw}“ ist ein lokaler Pfad, kein Artikel.` }));
    const url =
      address.kind === "path"
        ? `/api/inventory/warehouses/${encodeURIComponent(address.container)}/resolve?${new URLSearchParams({ path: address.path })}`
        : `/api/inventory/items/${encodeURIComponent(address.ref)}`;
    return ctx.readJson<Item>(await ctx.fetch(url));
  };

  const itemArg = {
    item: arg.required({
      valueLabel: "item",
      description: t({ en: "Item ID or <warehouse>:<path>", de: "Artikel-ID oder <lager>:<pfad>" }),
    }),
  };

  return defineCliCommands({
    name: "inventory",
    summary: t({ en: "Manage inventory items.", de: "Lagerartikel verwalten." }),
    commands: [
      command("ls", {
        summary: t({ en: "List items in a warehouse", de: "Artikel eines Lagers auflisten" }),
        args: { warehouse: arg.required({ description: t({ en: "Warehouse ID or name", de: "Lager-ID oder -Name" }) }) },
        async run({ ctx, args }) {
          const page = await ctx.readJson<{ items: Item[] }>(
            await ctx.fetch(`/api/inventory/warehouses/${encodeURIComponent(args.warehouse)}/items`),
          );
          printRows(ctx, page, page.items, [
            { key: "id", label: "ID" },
            { key: "path", label: t({ en: "PATH", de: "PFAD" }) },
          ]);
        },
      }),
      command("rm", {
        summary: t({ en: "Delete an item", de: "Einen Artikel löschen" }),
        args: itemArg,
        flags: { yes: confirmFlag(t({ en: "Confirm the deletion", de: "Löschen bestätigen" })) },
        async run({ ctx, args, flags }) {
          if (!flags.yes) throw new Error(t({ en: "Deleting needs --yes.", de: "Löschen braucht --yes." }));
          const item = await resolveItem(ctx, args.item);
          await ctx.readJson<unknown>(await ctx.fetch(`/api/inventory/items/${encodeURIComponent(item.id)}`, { method: "DELETE" }));
          if (!printStructured(ctx, { deleted: { id: item.id, path: item.path } }))
            ctx.print(`${t({ en: "Deleted", de: "Gelöscht" })} ${item.path} (${item.id})`);
        },
      }),
    ],
  });
};

const inventory = inventoryCommands();

export default {
  ...inventory,
  help: (locale?: string) => inventoryCommands(locale).help!(),
  run: (ctx: CloudCliContext) => inventoryCommands(ctx.options.locale).run(ctx),
};
```

`cld inventory rm "Main warehouse":cables/usb-c --yes` fails with
`"usb-c" matches several items: cables/usb-c (Ab12Cd), cables/usb-c (Ef34Gh).
Use one of these paths or IDs.` when two items share that path, and
`cld inventory rm Ab12Cd --yes` then deletes the intended one.

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

`access list` prints direct grants. Its table labels service accounts as
`agent` or `service account` and hides grants whose `serviceAccountKind` is
`resource_bound`, which belong to resource API keys, unless the caller passes
`--include-service-accounts`; those rows then show the type
`resource-bound`. JSON output always contains every entry. Return entries
from `resolveDisplayNames()`, or set `serviceAccountKind` yourself, so the
table can tell these accounts apart. An entry without `serviceAccountKind` is
shown as `service account`.

The CLI package also exports the helpers used by the generated commands:

| Helper | Use |
| --- | --- |
| `listAccessPrincipalEntities()` | Search users, groups, and optional service accounts |
| `resolveAccessPrincipal()` | Validate one principal flag and resolve it to a `Principal` |
| `printAccessEntries()` | Render grants in text, JSON, or JSONL |

Use them when an application needs a different command shape. Keep the same
principal resolution and output contracts.

## Register the module

Export the module from the application package, usually from `src/cli.ts`,
and declare it in `defineApp({ cli })`. Every application registers its module
this way, including the built-in ones: `cld` itself contains no application
module. Core serves the shared `account`, `admin`, `apps`, and `capabilities`
modules of `@k2b/cloud/cli` from its own image.

## Serve a module from the application

Each application serves its own `cld` plugin from its own image, so the
commands always match the Cloud version they talk to:

```ts
export const app = defineApp({
  id: "inventory",
  // ...
  cli: {
    inventory: { module: "src/cli.ts", references: "src/cli-references" },
  },
});
```

The key is the module name, the command `cld inventory …`. It must equal the
`name` of the module's default export. An application may serve several
modules. Both paths are relative to the application directory:

| Field | Rule |
| --- | --- |
| `module` | Source file whose default export comes from `defineCliCommands()`. |
| `references` | Directory of agent skill references: an `index.md` entry plus any further Markdown files, in subdirectories if needed. |

Write the references for agents that operate the application through `cld`:
start `index.md` with the task workflow and the safest commands, and link the
other files for details. Every file must be Markdown with a plain file name.

The production build bundles each module into one self-contained ESM file,
copies its references, and writes a manifest to `dist/cli/<name>/`. It imports
the bundle once and fails if the exported name differs from the declared key.
During development, the application builds the plugin from source on the
first request.

The framework serves every declared module and adds `/cli/plugins/<name>` to
the application's gateway routes. The registry entry lists the module names,
and Core lists all live plugins:

| Route | Content |
| --- | --- |
| `GET /cli/plugins` | `{ plugins: [{ name, app, version }] }` for every live module. Served by Core. |
| `GET /cli/plugins/<name>/manifest.json` | `apiVersion`, `name`, `app`, `version`, `entry`, `digest`, and `files` with the `size` and `sha512` of each file. |
| `GET /cli/plugins/<name>/cli.js` | The bundled module. |
| `GET /cli/plugins/<name>/references/<path>.md` | One skill reference. |

`version` is the version of the application build. The `digest` is the
SHA-512 of the `sha512sum` lines of all files, sorted by path, so it changes
whenever any file changes. `parseCloudCliPluginManifest()` from
`@k2b/cloud/cli` checks a manifest and its digest.

Only authenticated callers get any of these routes: a session, an OAuth token
with `read` scope, or an API key. The operator setting `cli.plugins.access`
excludes guest accounts by default; see
[Runtime configuration](/en/docs/operations/runtime-configuration#control-cli-plugin-access).
Plugin access protects the code only. Every command still goes through the
server's authorization.

## Ship a module as a plugin

A module can also ship as a package, for example a public command set that
does not belong to one application, or a module under development. Such a
plugin is an npm package, a `.tgz` archive of one, or a local directory
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

The names of the top-level commands (`help`, `version`, `login`, `logout`,
`auth`, `profile`, `update`, `plugins`) are reserved, and `reference` is
reserved as the first argument of every served module. `cld plugins install`
refuses a plugin whose ID matches a reserved name. Choose a distinct ID, such
as your application ID.

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

Plugins that a Cloud serves belong to the profile for that Cloud:

```sh
cld plugins list                 # available and installed plugins of the current profile
cld plugins list --all           # every profile
cld plugins install inventory    # one plugin from the current profile's Cloud
cld plugins install --all        # every plugin the Cloud serves
cld plugins update               # newer versions for the current profile
cld plugins update --all         # newer versions for every profile
cld plugins remove inventory
```

`cld login` offers to install the plugins that the Cloud serves once the
sign-in succeeds. `--yes` installs them without asking, and `--no-plugins`
skips the offer. A command whose plugin is not installed fails with a hint to
run `cld plugins install <name>`. `cld help` lists the modules installed for
the current profile.

`cld <module> reference [file]` prints a served plugin's skill references:
`index.md` by default, or one of the further files it links to. Agents read
them before using an unfamiliar module.

### Write the skill for agents

`cld` also writes the `cloud-cli` agent skill to disk. The core `SKILL.md`,
`references/sign-in.md`, and `references/plugins.md` are embedded in the `cld`
release; the installed modules add `references/<module>/<version>/` from the
plugin store, and `SKILL.md` gets a generated table from profile to module,
version, and reference folder. Profiles on different Clouds therefore see
different versions side by side, and a version no profile uses disappears.

The targets are `skills.targets` in the `cld` config. The first `cld login`
asks whether to write the skill to `~/.agents/skills` and also to
`~/.claude/skills` for Claude Code (`--yes` takes the default target); the
installer asks the same. A config that has never recorded an answer, such as
one from an older `cld`, gets the same question from `cld update` and
`cld skills sync`. Without a terminal and without `--yes`, nothing is asked or
written and `cld` prints the `cld skills add` command. An empty list, left by
`cld skills remove`, is an answer and is never asked again. Manage them with:

```sh
cld skills list
cld skills add ~/.claude/skills
cld skills remove ~/.claude/skills
cld skills sync
```

Every `cld plugins install`, `update`, and `remove`, every `cld login` that
installs plugins, every `cld profile rm`, and every `cld update` rewrite all
targets; `cld skills sync` does it on demand. `cld update --skills-dir <dir>` and `--claude-symlink` add
targets; `--no-skills` skips the rewrite once.

`install` and `update` read the plugin's manifest, download every file, check
each file's size and SHA-512 and the manifest digest, and load the module once
before anything changes. A mismatch leaves the installation untouched. The
plugin then goes to a content-addressed store,
`$XDG_CONFIG_HOME/cloud/cld/plugins/store/<digest>/`, and the profile locks
the module's app, version, and digest in the `cld` config. Profiles for
different Clouds can use different versions of the same module; identical
versions are stored once, and a version that no profile locks is deleted.
Without `XDG_CONFIG_HOME`, the directory is `~/.config/cloud/cld/plugins/`.

`cld profile rm <name>` removes a profile together with its lock. It signs the
profile out first, revoking an OAuth login like `cld logout`, then deletes the
versions no remaining profile locks and rewrites the skill. It asks for
confirmation, or needs `--yes` without a terminal, and refuses the current
profile while other profiles exist; `cld profile use <other>` selects another
one first.

A plugin needs the same plugin API version as `cld`. A newer API asks you to
run `cld update`; an older one needs a newer Cloud.

### Install a package plugin

A package plugin is available to every profile. Use it during development or
for commands that no Cloud serves:

```sh
cld plugins install npm:@example/inventory-cli@1.4.0
cld plugins install ./inventory-cli-1.4.0.tgz
cld plugins install ./packages/inventory-cli
cld plugins run inventory items get <item-id>
cld plugins remove inventory
```

A path contains a `/` or ends in `.tgz`; an npm package starts with `npm:`.
Anything else is the name of a plugin that the Cloud serves, so a mistyped name
never falls back to the public registry. npm packages come from the public
registry; pass an exact version or a dist-tag, the default is `latest`. `cld`
checks the tarball against the registry's `sha512` integrity value. To install
from a private registry, download the archive with `npm pack <package>` and
install the `.tgz` file.

Before it places a package plugin, `cld` checks the manifest and shows the
package, version, and source. It asks for confirmation unless you pass
`--yes`, and without a terminal it requires `--yes`. It then loads the module
and installs it under `cloud/cld/plugins/<id>/`. Installing the same ID again
replaces it. You can also place an unpacked plugin directory there by hand;
`cld plugins list` shows its source as `manual`. A package plugin and a plugin
that a profile locks cannot share a name; remove one before you install the
other.

`cld plugins list` shows the profile (`*` for package plugins), name, app,
installed and available version, status, and source:

| Status | Meaning |
| --- | --- |
| `ok` | The installed plugin is current, or the package plugin loads. |
| `available` | The Cloud serves the plugin; it is not installed. |
| `update available` | The Cloud serves a different version than the profile locks. |
| `not served` | The profile locks a plugin that the Cloud no longer serves. |
| `unknown` | The Cloud could not be reached. |
| `shadowed` | A later `cld` release added a built-in command with the same name. It takes precedence for `cld <id>`; run the plugin with `cld plugins run <id>`. |
| `incompatible` | The package names a plugin API version that this `cld` does not support. |
| `error` | The package manifest, the entry, or the module is invalid, or the entry fails to load. |

A plugin's commands run as `cld <name> …`. `cld plugins run <name> …` runs the
same command tree and always reaches the plugin, even when it is shadowed, so a
new built-in command never makes an installed plugin unreachable. Use it in
scripts that must keep working across `cld` upgrades.

`cld help` lists the current profile's plugins and the package plugins, and
prints one warning line on stderr for each package plugin that it skips. A
broken plugin fails only its own commands. The top-level commands never load
plugins.

## Plugin security

A plugin is not sandboxed. It runs inside `cld` with the permissions of your
operating-system account and receives the `CloudCliContext` of the host: the
selected profile, the Cloud credentials, the locale, and the output mode. Plugins do not get extra privileges or access to other
plugins through `cld`, but their code can read any file that you can read.

A plugin that a Cloud serves comes from that Cloud's application image over
the authenticated connection of the profile. Package plugins come from the
source you name; install them only from sources that you trust, and pin a
version for repeatable installations. Cloud authorizes plugin requests exactly like other
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
