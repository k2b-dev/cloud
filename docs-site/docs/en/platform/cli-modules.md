---
title: Application CLI modules
navTitle: CLI modules
section: Platform services
order: 595
description: Expose application operations through the shared cld command-line interface.
tags: [cli, cld, automation, plugins]
updated: 2026-10-15
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

`cld` resolves one locale per invocation: `--locale <BCP-47-tag>` wins over
`CLD_LOCALE`, then the first non-empty POSIX variable `LC_ALL`, `LC_MESSAGES`,
or `LANG`. POSIX values such as `de_DE.UTF-8` become `de-DE`; charset and
modifier suffixes are dropped. `C`, `C.*`, `POSIX`, and invalid POSIX tags
provide no usable locale, even when a lower-priority variable has one.
Invalid explicit tags still produce an error. Regional tags use normal
ancestor fallback, so `de-CH` uses German CLI text when no Swiss German
message exists.

The resolved tag is available as `ctx.options.locale` and is sent as
`Accept-Language` with every authenticated application request. Without a
usable locale, `ctx.options.locale` is undefined and CLI text falls back to
English; requests omit `Accept-Language`, so the operator default `app.locale`
applies. This keeps server-owned API messages aligned with the request locale
without process-global locale state.

The same requests carry the machine's IANA timezone (`TZ` overrides it)
in the `cloud.timezone` cookie that browsers send, so `getTimeZone(c)` and
day-based filters such as "due today" use the local day. A machine without a
configured timezone, such as most containers and CI runners, sends `UTC`
rather than falling back to `app.timezone`. The cookie only carries the
timezone; authentication still comes from the bearer token.

For application-owned text, use `cliText(ctx, { en, de })` at the final
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

### Declare short names

A module may declare one `alias` for the whole module and `shortcuts` for
individual command paths:

```ts
export default defineCliCommands({
  name: "inventory",
  alias: "inv",
  shortcuts: { stock: "items list" },
  summary: "Manage inventory items.",
  commands: [
    command("items list", { summary: "List inventory items", run: listItems }),
  ],
});
```

`cld inv items list` runs `cld inventory items list`. `cld stock` runs
`cld inventory items list`; additional arguments and flags follow that path.

Alias and shortcut names must match `CLOUD_CLI_MODULE_NAME`
(`^[a-z][a-z0-9-]*$`). They must differ from the module name and from each
other. Shortcut targets are non-empty, space-separated command paths relative
to the module. `defineCliCommands()` normalizes whitespace and requires an
exact command with its own handler. A generated group alone, an unknown path,
preset flags, and preset arguments are invalid.

Core commands take precedence, followed by modules with exactly the requested
name, then short names. Names of package plugins and modules the profile's
Cloud serves are reserved, including modules the profile has not installed.
`cld` resolves short names from saved metadata without contacting the Cloud.
The served names are the list `cld` saw the last time it listed the Cloud's
plugins during `cld login`, `cld plugins list`, `install`, or `update`.
Until a profile has such a list, its short names are inactive. A module the
Cloud starts serving later takes its name back at the next of these commands.
Until then, a short name with that name still runs its plugin.

If more than one installed module claims a name, or the name collides with a
core command or module, the short name is inactive for every claimant. The last
installed plugin never wins a conflict. `cld help` and `cld plugins list`,
`install`, and `update` warn about inactive names on stderr. Installing a
package plugin also warns when it makes a short name inactive.

Agents and scripts should use full module names: a short name may be inactive
on another profile.

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

Command help marks flags declared with `required: true` and no `default` as
`Required.`

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

Use `cloudResourceUrl(ctx, ref)` from `@k2b/cloud/cli` to produce an absolute
resource link on the selected profile's server. When returning a resource
object, use `withCloudResourcePermalink(ctx, type, resource)` to add that link
as `permalink`; `resource.id` must be the ID the Type's reader accepts. Link a
derived entry, such as one occurrence of a recurring event, to the resource its
reader accepts, and give entries the caller may see but not read no link. The URL
uses `/open/<type>/~<encoded-id>` with a required `~` prefix.
Generic capability commands convert provider semantic links to absolute URLs
and add `permalink` to refs with live readers. A provider's `open`, the
consumer's `href` and the CLI's `permalink` are described together in
[Resource links](/en/docs/platform/capabilities#resource-links).
Include links only for resources that remain readable after the command, and
in text output only on create-style confirmations.

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
| `openUrl?()` | Open an http(s) link in the user's browser; resolves false when the host cannot, so print the link too; absent in hosts without a browser |
| `profiles?.saveClientCredentials()` | Store an OAuth client ID and secret as a client-credentials profile; absent in hosts without profiles |

`readJson()` accepts native fetch responses and typed Hono client responses.
It requires `json()`, `text()`, `ok`, `status`, and `statusText`.

`profiles` is optional. A command that provisions a machine credential, such
as `cld admin agents create`, hands the secret to `saveClientCredentials()`
and never prints it; the host stores it with the same protection as a refresh
token. Fail before any remote call when the capability is missing.

`openUrl` is optional; always print the link so it remains usable when the
capability is absent or returns false.

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
| `scopes` | No | Parts of the resource a grant can cover, the whole resource first; adds `--scope` |
| `resourceArgLabel` | No | Value label shown for resource arguments |
| `resourceArgDescription` | No | Help text for resource arguments |
| `examples` | No | Examples for each generated access command |

When a resource offers grants on part of it, such as Mail's conversations
assigned to a person, list the scope names its access API uses in `scopes`,
with the name of the whole resource first. `access grant` and `access set`
then accept `--scope` and pass it to `grant` and `update` as their last
argument; without the flag they pass `undefined`, which means the whole
resource for a new grant and the grant's current scope for a change.
`access list` adds a `SCOPE` column that shows the entry's `scope` or the
whole-resource name.

Public grants and service-account grants are disabled unless the adapter
explicitly enables them. Principal search uses the same Accounts endpoint as
`PermissionEditor`.

`access list` prints direct grants. Its table labels service accounts as
`agent`, `user-bound`, or `service account`, following the kind labels of
`PermissionEditor`, and hides grants whose `serviceAccountKind` is
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
When the application accepts authored content, such as Markdown with its own
blocks or files in particular formats, list every supported construct with one
compact example and test the examples against the real renderer. The core
`cloud-cli` skill only routes agents to these references.

The production build bundles each module into one self-contained ESM file,
copies its references, and writes a manifest to `dist/cli/<name>/`. It imports
the bundle once and fails if the exported name differs from the declared key.
During development, the application builds the plugin from source on the
first request.

Served plugins using Playwright carry its package and browser metadata in the
bundle. The client still needs a Chromium executable: for Assistant, install
Playwright Chromium or set `CLOUD_CLI_CHROMIUM` to its local path.

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

Authors without a Cloud application can ship a module as an npm package,
a `.tgz` archive, or a local directory. Use the same verified bundle format
that applications serve. The source package needs string `name` and `version`
fields in `package.json`. The module exports `defineCliCommands()` as its
default export. Its `name` becomes the command and plugin ID.

Pack the module and its Markdown references from the source package directory:

```sh
bun run node_modules/@k2b/cloud/scripts/cli-pack.ts src/cli.ts --references references --out dist/plugin
npm publish dist/plugin
# Or create an archive:
npm pack ./dist/plugin
```

Inside the Cloud monorepo, run `bun run packages/cloud/scripts/cli-pack.ts`
with the same arguments. The references directory must contain `index.md`.
Nested Markdown files keep their paths. The script uses the application plugin
builder and bundles dependencies into one ESM file, including `@k2b/cloud/cli`.
`cld` installs no plugin dependencies.

The output contains:

```text
package.json
manifest.json
cli.js
references/index.md
references/guides/setup.md
```

The generated `package.json` declares the bundle manifest:

```json
{
  "name": "@example/inventory-cli",
  "version": "1.4.0",
  "type": "module",
  "cld": { "manifest": "manifest.json" }
}
```

The manifest's `app` and `version` match the package name and version.
`cld.manifest` is a relative file path inside the package. Its parent directory
holds the bundle. The manifest lists `cli.js` and every reference with its
size and SHA-512, and carries the digest of that file list.

The output directory must be absent, empty, or a previous pack output containing
only `package.json`, `manifest.json`, `cli.js`, and `references`, with
`cld.manifest` equal to `"manifest.json"`. Repacking removes previous output
first, so stale files disappear. Other non-empty directories are refused.
The output must not equal or contain the current directory, module file, or
references directory.

Top-level commands (`help`, `version`, `login`, `logout`, `auth`, `profile`,
`update`, `plugins`, `skills`) are reserved. `reference` is reserved as the first
argument of every installed module, so `defineCliCommands()` refuses a
top-level `reference` command. Installing a reserved module name is
refused. Command names, flags, and JSON output stay stable across versions.

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

Short names need both the profile's plugin lock and its saved list of served
modules. `cld plugins install` or `cld plugins update` saves the lock. The served
list is saved when `cld login`, `cld plugins list`, `install`, or `update`
successfully lists the Cloud's plugins. `cld help` shows active
aliases beside module names and lists command shortcuts. Package plugins do
not get short names.

`cld <module> reference [file]` prints every installed module's skill references:
`index.md` by default, or one of the further files it links to. Agents read
them before using an unfamiliar module.

### Write the skill for agents

`cld` also writes the `cloud-cli` agent skill to disk. The core `SKILL.md`,
`references/sign-in.md`, and `references/plugins.md` are embedded in the `cld`
release; the installed modules add `references/<module>/<version>/` from the
shared plugin store. `SKILL.md` gets a table with Profile, Module, Version,
Summary, and Start. Start links to `references/<module>/<version>/index.md`.
Package plugins appear once with Profile `*` when active in at least one
profile, or when no profiles exist. A profile lock takes precedence over a
package plugin of the same name. Inactive modules get no row. Profiles on
different Clouds see their versions side by side. When two different bundles
share a module name and version, such as a served build and a package, each
folder gets a short digest suffix, `references/<module>/<version>+<digest>/`,
so every row points at its own references. Unused reference folders
disappear on the next sync.

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
versions are stored once. A version is deleted only when no profile lock or
package record uses it.
Without `XDG_CONFIG_HOME`, the directory is `~/.config/cloud/cld/plugins/`.

`cld profile rm <name>` removes a profile together with its lock. It signs the
profile out first, revoking an OAuth login like `cld logout`, then deletes the
versions no remaining profile lock or package record uses and rewrites the skill. It asks for
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

Before confirmation, `cld` checks the package and bundle manifest, API
compatibility, package name and version, reference file list, and name
conflicts. It refuses symlinks anywhere in the bundle and unlisted reference
files. Files outside the bundle directory are ignored.

The confirmation shows the package, version, resolved source, module name,
and reference count. It states that the plugin runs inside `cld` with the
user's Cloud credentials. Without a terminal, installation requires `--yes`.
Plugin code runs only after confirmation.

Package and served plugins use the same verification: exact size and SHA-512
for every listed file, manifest digest, and module shape and name. A mismatch
leaves the installation untouched. Both live in `plugins/store/<digest>/`.
Global package records live in `plugins/packages.json`, independent of profiles
and `CLD_CONFIG`. Installing the same module again replaces its record and
removes an old-format directory of that ID. Skill targets sync automatically
after package install and removal too.

Removing or replacing a package deletes only its own old bundle, and only if
no profile lock in the current config or remaining package record uses it.
Other unused bundles are removed at the next served plugin change or profile
removal.

Old packages with `cld.apiVersion` and `cld.entry` are refused. Their authors
must re-pack with `cli-pack.ts` and publish the new package. Existing
`plugins/<id>/` directories are listed as `incompatible` and never loaded.
Remove them with `cld plugins remove <id>`.

Update a package plugin by installing its new package again with
`cld plugins install <source>`. A package plugin and a profile-locked plugin
cannot be installed with the same name; remove one before installing the other.

`cld plugins list` shows the profile (`*` for package plugins), name, app,
installed and available version, status, and source. The SHORT NAMES column
shows the alias and shortcuts; `(inactive)` marks a name with a conflict or
without a served list. JSON rows include `alias` (a string or null), `shortcuts`
(an object, empty when none), and `inactive` (a list of names). Package plugin
rows and uninstalled rows have `alias: null`, `shortcuts: {}`, and `inactive: []`.
The status values are:

| Status | Meaning |
| --- | --- |
| `ok` | The installed plugin is current, or the package record has an entry in the store. |
| `available` | The Cloud serves the plugin; it is not installed. |
| `update available` | The Cloud serves a different version than the profile locks. |
| `not served` | The profile locks a plugin that the Cloud no longer serves. |
| `unknown` | The Cloud could not be reached. |
| `shadowed` | A later `cld` release added a built-in command with the same name. It takes precedence for `cld <id>`; run the plugin with `cld plugins run <id>`. |
| `incompatible` | An old-format package directory must be re-packed by its author. |
| `error` | A package record points to a missing store entry. Reinstall from its recorded source. |

A plugin's commands run as `cld <name> …`. `cld plugins run <name> …` runs the
same command tree and always reaches the plugin, even when it is shadowed, so a
new built-in command never makes an installed plugin unreachable. Use it in
scripts that must keep working across `cld` upgrades.

`cld help` lists the current profile's plugins and the package plugins, and
prints one warning line on stderr for each old-format directory it skips. A
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
