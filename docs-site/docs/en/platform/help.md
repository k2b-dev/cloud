---
title: In-product Help
navTitle: In-product Help
section: Platform services
order: 580
description: Declare app-owned Markdown once for the shared Help UI, full-page Help, Assistant, and MCP.
tags: [help, markdown, product, agents]
updated: 2026-09-15
---

# In-product Help

Declare an application's product guidance once. Cloud can then expose the same
Markdown through the shared Layout, full-page Help, Assistant search and reads,
and the authenticated [Cloud MCP server](/en/docs/platform/mcp).

The single declaration keeps human and agent guidance aligned even when the
application is developed and released outside the Cloud repository. It is a
public application contract; no built-in package or repository integration is
required.

Help is for static product guidance: tasks, concepts, reference material, and
troubleshooting. Use developer documentation for application APIs. Keep live,
permission-sensitive data in an authorized Query or application route.

| The application owns | Cloud owns |
| --- | --- |
| Markdown content and article order | Validation and bounded registration |
| Stable article IDs and useful metadata | Layout Help and full-page Help |
| Whether the content is safe to expose as product guidance | Search, reads, and agent discovery |
| Specialized embedded presentation, when needed | Publication lifecycle and derived routes |

## Keep Help in one module

When an application owns Markdown Help, put the declaration in
`src/help/index.ts` and keep every Markdown source below `src/help/`:

```text
src/help/
├── index.ts
└── documents/
    ├── inventory-start.help.md
    └── inventory-access.help.md
```

Small collections may place Markdown files directly beside `index.ts`. A
larger collection may group them under `documents/`. Both follow the same
boundary: the declaration and its content stay in `src/help/`.

Use one declaration module to avoid ambiguous imports. Use `src/help/index.ts`
for file-backed Help, or `src/help.ts` when it owns no Markdown files.

Cloud does not scan the filesystem. Import every article and list it explicitly
so ownership, review order, and bundle contents remain visible.

### Add localized articles

Keep all languages in the same Help declaration. Use one folder per canonical
locale when an application ships translations:

```text
src/help/
├── index.ts
└── documents/
    ├── en/
    │   ├── inventory-start.help.md
    │   └── inventory-access.help.md
    └── de/
        └── inventory-start.help.md
```

The base locale is complete and owns the logical article IDs, icons, and order.
A localized folder may contain only the translated articles available today.
It owns their title, description, and Markdown body. Keep the same `id`; do not
create language-specific IDs or duplicate Help registrations. Localized
frontmatter may omit `icon` and `order`; if repeated, they must match the base.

Cloud resolves each article through the exact requested locale, its BCP 47
ancestors, then the base locale. For example, `de-CH` can use a `de-CH` article,
fall back to `de` for another article, and finally use `en` for an untranslated
article.

## Write an article

Each article is a Markdown asset with YAML frontmatter:

Follow [Product language and tone](/en/docs/build/product-language-and-tone)
for task structure, terminology, English and German prose, and translation
equivalence.

```md
---
id: inventory-start
title: Start with Inventory
icon: ti ti-package
description: Create and update inventory items.
order: 10
---

# Start with Inventory

**First steps**

## Create an item {icon="plus"}

Open Inventory and choose **New item**.
```

| Field | Required | Contract |
| --- | --- | --- |
| `id` | Yes | Lowercase kebab case; unique in the Help declaration |
| `title` | Yes | Non-empty article title |
| `order` | No | Integer; defaults to `100` |
| `icon` | No | Tabler icon classes for the article |
| `description` | No | Short search and overview text |

The body must not be empty. Articles are sorted by `order`, then by title.

Every level-two heading in a registered application article ends with icon
metadata:

```md
## Create an item {icon="plus"}
```

Cloud removes the metadata from the visible title and uses it in article
navigation. Heading IDs must be unique after slugging.

### Use guided blocks

Help supports three guided blocks:

| Block | Use |
| --- | --- |
| `steps` | Ordered task |
| `reference` | Compact facts or controls |
| `compare` | Alternatives or differences |

The block contains normal Markdown:

```md
:::steps
1. Enter a name.
2. Set the initial quantity.
3. Choose **Create**.
:::
```

A paragraph containing only bold text becomes an eyebrow. Use it as a short
label, not another heading.

### Use callouts

Callouts support `note`, `info`, `success`, `warning`, and `danger`:

```md
:::warning Before deleting
Deleting an item cannot be undone.
:::
```

Callout text supports bold, emphasis, inline code, and line breaks. It does not
parse lists, links, tables, or nested blocks. Put those after the callout.

The shared `markdown.render()` and `markdown.renderSync()` helpers from
`@k2b/cloud/shared` render the same callouts. Pass `{ notices: "minimal" }` to
show only the tone color: the icon and the automatic type label disappear, an
explicit title stays visible, and screen readers still hear the type name.

The Help renderer also:

- enables GitHub-flavored Markdown;
- turns source line breaks into visible line breaks;
- sanitizes rendered HTML;
- keeps internal links in the current tab and opens external links in a new tab;
- renders code without executable scripts.

Do not use Mermaid in Help articles. The Help reader does not start the Mermaid
client renderer.

## Define Help once

Import the articles in `src/help/index.ts` and pass only the documents to
`defineHelp()`:

```ts
import { defineHelp } from "@k2b/cloud";
import access from "./documents/inventory-access.help.md" with {
  type: "text",
};
import start from "./documents/inventory-start.help.md" with {
  type: "text",
};

export const inventoryHelp = defineHelp({
  documents: [start, access],
});
```

For localized Help, map explicitly imported sources by locale:

```ts
import accessEn from "./documents/en/inventory-access.help.md" with { type: "text" };
import startEn from "./documents/en/inventory-start.help.md" with { type: "text" };
import startDe from "./documents/de/inventory-start.help.md" with { type: "text" };

export const inventoryHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [startEn, accessEn],
    de: [startDe],
  },
});
```

The declaration has no route, base path, role, router, or Layout configuration.
Cloud already knows the owning application's ID and base path when it starts.

`defineHelp()` validates the article shape and creates an immutable source
declaration. Startup compiles the complete collection, rejects duplicate IDs,
and calculates its manifest hash before the application advertises Help.

One Markdown article is limited to 128 KiB. The former 512 KiB limit on the
combined collection no longer applies, and search text is retained for every
language. Invalid articles fail startup before the application advertises Help.

Core creates the shared Help schema in Postgres during setup. Applications
publish their complete collection in a transaction before advertising readiness.
An unchanged content hash reuses the stored collection; a changed hash publishes
a separate version. The app registry carries only the current hash and route
metadata. Article metadata and Markdown live in Postgres.

## Register Help when the app starts

Pass the declaration to `app.start()` next to other executable app-owned
surfaces such as capabilities:

```ts
import { defineApp } from "@k2b/cloud";
import { Hono } from "hono";
import { inventoryHelp } from "./help";

const app = defineApp({
  id: "inventory",
  name: "Inventory",
  description: "Track inventory items.",
  icon: "ti ti-package",
  basePath: "/app/inventory",
  baseUrl: "http://app-inventory:3000",
  routes: ["/app/inventory"],
});

const router = new Hono().get("/app/inventory", (c) =>
  c.html("<h1>Inventory</h1>"),
);

export default await app.start({
  help: inventoryHelp,
  fetch: router.fetch,
});
```

Do not mount a Help API router, render a `Layout.HelpDocuments` registrar, or
add standalone Help page routes. Those are consumers of the registration, not
additional declarations.

The existing app heartbeat renews the published collection before renewing app
registration. If the collection disappears, that heartbeat republishes it from
the application declaration. Core must recreate a missing schema before this
can succeed. Persistent registration failures use the existing app-lease
failure policy and restart the process.

Core removes at most one expired collection per minute. A collection becomes
eligible after six minutes without renewal: two app-lease lifetimes. Stopping
one replica does not delete Help used by another. Stored collections from
unavailable applications are not exposed as current Help.

## Use the automatically derived surfaces

For the example above, Cloud derives these product routes:

| Surface | Derived route or behavior |
| --- | --- |
| Layout Help | Registers the current app's manifest automatically |
| Help overview | `/app/inventory/help` |
| Article deep link | `/app/inventory/help/:documentId` |
| Search data | `/api/help/v1/inventory/search?q=...` |
| Article data | `/api/help/v1/inventory/documents/:documentId` |
| Agents | Use `search_help` and `read_help` against the same live corpus |

The full-page routes come from the application's `basePath`. Applications do
not repeat that path in their Help declaration. Core owns search and article
transport and the shared reader; the derived application routes forward to
that reader while the application remains the content owner.

SSR loads the current application's localized article metadata from Postgres.
The browser receives this manifest and loads article bodies on demand. An
agent uses bounded search and read operations; Cloud does not create one
permanently loaded tool for every article.

Every automatic surface uses the same request locale. Article responses and
AI/MCP matches report each article's actual content locale. Browser article
caches distinguish locales, so regional fallback cannot mix content between
requests. AI and MCP clients receive final localized titles, descriptions, and
Markdown; they never receive application message keys.

For a user-backed direct chat on a tool-capable model, AI Core resolves
`search_help` and `read_help` dynamically through the shared Help service. This
does not require capability discovery to be enabled. Applications register
their Help declaration only; they do not define AI tools or provider settings.
Tool discovery does not load article bodies. A temporary Help read failure is
isolated from ordinary chat and app capabilities; a later tool call can retry.

Every reader selects the hash advertised by the current app registration.
Missing articles or versions are not served from an older collection. Database
failures remain errors rather than appearing as successful empty searches.
The application heartbeat can restore a missing collection.

## Search product guidance

UI, Assistant, and MCP use the same PostgreSQL search and locale selection.
Search accepts up to 200 characters and returns at most 25 results. Use concise
terms in the request language. English and German articles use their respective
PostgreSQL language configurations; other languages use `simple` tokenization.
Exact article IDs and titles rank first. Native full-text search weights titles
above descriptions and body text. Whitespace-separated terms must all match;
quoted phrases, `OR`, and exclusions follow PostgreSQL web-search syntax.

Cloud chooses one language variant per article before searching. A `de-CH`
request can therefore return a German article and an untranslated English
article, each reporting its actual content locale. It does not search a hidden
English translation and then open a different German article.

When the operator has enabled `pg_textsearch` and all three Help search indexes
are valid, Cloud uses BM25 to rank matching articles after exact-title/ID
priority. Without it, native full-text search remains available. Both paths
use the same matching and language rules; ordering can differ. The Help UI
preserves the returned document order and uses local metadata matches while
a search is pending or unavailable. See
[Deployment requirements](/en/docs/operations/deployment-requirements#optional-help-search-ranking)
for installation and verification.

`read_help` and `cloud__help__read` return at most 7,000 characters, selecting
relevant sections when a query is supplied. An exact level-two heading selects
that section. Full article reads in the UI and MCP resources still return the
complete article.

## Keep the content safe to expose

The Help declaration has no per-article role or authorization callback.
Registered Help is static product guidance, not a resource authorization
boundary. Any actor that can reach Cloud's central Help surface may read it.

Do not include:

- secrets, tokens, internal hostnames, or credentials;
- user, tenant, or resource data;
- role-restricted operational state;
- instructions whose disclosure itself requires a permission check.

Put dynamic or permission-sensitive context in a Query such as `gql.context`.
The Query must authorize every request through the current access subject.
Links from Help may point to protected application pages; those pages still
perform their normal authorization.

## Reuse the declaration for specialized readers

An application may need a focused embedded reader, such as the Grids GQL
reference. That consumer may select documents from the same Help declaration.
It must not create another collection, registry entry, API router, or copied
manifest.

Use the automatic Layout and full-page surfaces for ordinary application Help.
Add a specialized consumer only when its surrounding workflow needs a distinct
presentation.

For server-rendered embedded readers, `preloadLayoutHelp(c, appId)` from
`@k2b/cloud/ssr/help` loads the published, request-localized metadata. Reuse its
`documents` and derived URLs; do not read article lists from the app registry.
The explicit app ID also supports public Help pages. Automatic layout loading
only runs for signed-in users.

## Verify Help

`defineHelp()` validates document frontmatter and duplicate IDs when the module
loads; `app.start()` compiles the bounded corpus and fails instead of publishing
an invalid registration. Keep a small application-owned test that imports the
declaration so those checks run in CI.

Before shipping, also verify:

- the application package typecheck;
- application startup with the complete Help declaration;
- Layout Help in normal and focus modes;
- the overview and one article deep link;
- search and article reads;
- one agent Help search and read;
- any specialized embedded reader;
- recovery after the published collection disappears.

Cloud repository maintainers additionally run the repository-wide Help corpus
checks for built-in applications. Third-party application CI does not depend on
those private source paths.

For a focused reference read, pass an exact level-two heading as the `read_help`
query. The response selects that section, including its examples, within the
existing read limit. Other queries retain ranked topic matching.
