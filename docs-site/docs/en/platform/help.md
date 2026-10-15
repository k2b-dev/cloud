---
title: In-product Help
navTitle: In-product Help
section: Platform services
order: 580
description: Declare app-owned Markdown once for the shared Help UI, full-page Help, Assistant, and MCP.
tags: [help, markdown, product, agents]
updated: 2026-10-14
---

# In-product Help

Declare an application's product guidance once. Cloud can then expose the same
Markdown through the shared Layout, full-page Help, Assistant search and reads,
and the authenticated [Cloud MCP server](/en/docs/platform/mcp). These Cloud
surfaces show an application's Help only to signed-in users who may see that
application; see [Who can read Help](#who-can-read-help).

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
| Whether the content is safe for everyone who sees the app | Who can read Help, search, reads, and agent discovery |
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

The base locale is complete and owns article IDs and navigation metadata.
A localized folder may contain only the translated articles available today.
It owns their title, description, and Markdown body. Keep the same `id`; do not
create language-specific IDs or duplicate Help registrations. Localized
frontmatter may omit `icon`, `order`, `kind`, `needs`, `next`, and `related`;
omitted fields inherit the base value. If repeated, they must match exactly,
including the order of the `related` list.

Cloud resolves each article through the exact requested locale, its BCP 47
ancestors, then the base locale. For example, `de-CH` can use a `de-CH` article,
fall back to `de` for another article, and finally use `en` for an untranslated
article.

## Write an article

Each article is a Markdown asset with YAML frontmatter:

Follow [Write app help](/en/docs/build/write-app-help) for article structure,
step and sentence rules, and the [Cloud glossary](/en/docs/reference/glossary)
for product terms. [Product language and tone](/en/docs/build/product-language-and-tone)
covers the voice of all product text and translation equivalence.

```md
---
id: inventory-start
title: Start with Inventory
kind: start
icon: ti ti-package
description: Create and update inventory items.
order: 10
---

# Start with Inventory

**First steps**

## Create an item

Open Inventory and choose **New item**{icon="plus"}.
```

| Field | Required | Contract |
| --- | --- | --- |
| `id` | Yes | Lowercase kebab case; unique in the Help declaration |
| `title` | Yes | Non-empty article title |
| `order` | No | Integer; defaults to `100` |
| `icon` | No | Tabler icon classes for the article |
| `description` | No | Short search and overview text |
| `kind` | No | `start`, `task`, `reference`, or `troubleshoot`; defaults to `task` |
| `needs` | No | One glossary access level: `view`, `edit`, or `manage`; never an app-specific permission |
| `next` | No | Same-app document ID for the next task; cannot point to itself |
| `related` | No | Ordered list of `<id>` or `<app>/<id>` references; defaults to `[]`; no duplicates |

The body must not be empty. Articles are sorted by `order`, then by title.

Level-two headings need no icon metadata. An optional trailing
`{icon="plus"}` is removed from the title and ignored by the reader.
Heading IDs keep the same slugging rules and must be unique.

### Name keys, labels, and menu paths

These forms belong to Help Markdown. Ordinary content Markdown keeps its
existing syntax.

| Source | Reader |
| --- | --- |
| `:kbd[mod+k]` | Key caps for the reader's platform: Ctrl and K, or ⌘ and K on Mac |
| `**Hide**{icon="eye-off"}` | A label chip with the control's icon; inline Markdown stays supported |
| `**Space settings → Sharing**` | Two label chips joined by ›, with → for screen readers |
| `**Space settings → Sharing**{icon="settings"}` | A menu path with the icon on its first chip |

Icon names use lowercase letters, digits, and hyphens. Plain bold text stays
bold. A shortcut must format to at least one key; invalid shortcuts fail
startup. Code spans and fenced examples remain literal.

### Link related guidance

Use `[Share](help:inventory-sharing#invite)` for a same-app article and
`[Reply](help:mail/mail-invitations#reply)` for another app. The reader resolves
each target in its current published corpus and language, using the same app
visibility rule as article reads. Resolved links use
`/help/apps/<app>/<id>#section`. Unknown or invisible targets render only the
link text and expose no target address. `next` and `related` use this same
resolution; unresolved entries are omitted. Write `help:` links inline: a reference
definition, autolink, image, or HTML attribute with a `help:` target fails
startup. Help syntax that remains unconverted in agent text also fails startup.

### Use guided blocks

Help supports these guided blocks:

| Block | Use |
| --- | --- |
| `steps` | Ordered task |
| `reference` | Compact facts or controls |
| `compare` | Alternatives or differences |
| `details Question` | Collapsed reasons or special cases; a title is required |

The block contains normal Markdown:

```md
:::steps
1. Enter a name.
2. Set the initial quantity.
3. Choose **Create**.
:::
```

Keep the main task short. Put reasons and special cases in details:

```md
:::details What happens to existing items?
Inventory keeps the items you already created.

:::steps
1. Open **Items**.
2. Choose **Export**{icon="download"}.
:::
:::
```

Details start collapsed. Their full body remains searchable and is given in
full to agents. They can contain steps, reference, and compare blocks and
ordinary Markdown. A callout inside details fails startup: a warning or note
belongs where the reader sees it. An opener without a title, or one that is
never closed, fails startup.

A paragraph containing only bold text becomes an eyebrow. Use it as a short
label, not another heading.

### Use callouts

Callouts support `note`, `info`, `success`, `warning`, and `danger`:

```md
:::warning Before deleting
Deleting an item cannot be undone.
:::
```

The callout body is ordinary Markdown: emphasis, links, lists, tables, and
code render as they do elsewhere on the page. Close the callout with `:::` on
its own line; a `:::` inside code or a list does not close it. Callouts inside
lists, quotes, or another callout stay text.

A callout shows its type's icon and a light tint. The icon and title use the
tone colour; body text stays neutral. The icon is decorative. The optional
plain-text title names the callout. Without a title, screen readers hear the
type name in the Help document's language. Sighted readers see the icon and
tint only, so add a title when the type matters.

Callouts are one syntax and one look across Cloud: `MarkdownView` from
`@k2b/ui`, the shared `markdown.render()` and `markdown.renderSync()` helpers
from `@k2b/cloud/shared` (pass `{ locale }` to name untitled callouts in the
reader's language), Notebooks, and Markdown PDF exports. See
[Markdown content](/en/ui/content/markdown#info-blocks) for the exact rules.
A Cloud renderer with its own `sanitize-html` pass spreads
`markdownCalloutSanitizeOptions()` from `@k2b/cloud/shared` into its options,
creating fresh options for each sanitization, so the callout icon survives
and every other SVG is still discarded.

By default these helpers render links like `MarkdownView`: a relative link is
a reference pill with a type icon, and a web or mail link is quiet text with a
thin accent underline (see
[Markdown content](/en/ui/content/markdown#links-and-references)). A raw
anchor inside a link's text stays text. A Notebooks `note://` or `attach://`
link renders as its text, because only Notebooks resolves it.
Pass `{ links: "plain" }` when the HTML is read outside Cloud, for example in
email. Each link then renders as an ordinary anchor around its text instead.
Plain output also renders a code block, fenced or indented and including a
Mermaid fence, as its source in a `pre`, without the language label or diagram.
Email drops the screen-reader styling, so an
untitled callout shows its type name there as text. HTML that Cloud renders
without one reader's locale, such as notification batches, announcements, and
messages written in Mail, names untitled callouts in English; give those
callouts a title in the readers' language.

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
Same-app IDs in `next`, `related`, and `help:` links must exist in the base
locale. This includes references prefixed with the owning app ID. Validation
names the locale, document, and bad reference; code examples are ignored.
Cross-app references resolve for the reader at read time and do not prevent
startup. Unknown extra frontmatter fields are stripped. Help reserves `kind`,
`needs`, `next`, and `related`: an article that uses one of these keys for
something else fails startup. Third-party articles with only `id`, `title`,
`icon`, `description`, and `order` keep working.

One Markdown article is limited to 128 KiB. Search text is retained for every
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

Full-page Help renders in the owning application's frame. The rail marks that
app, its canvas and accent apply, and the title row leads back to the app.
Third-party applications use the same frame.

Links to another article or section of the same app's Help open inside the
reader without reloading: `/app/<id>/help/<documentId>`,
`/help/apps/<id>/<documentId>`, or `#section`. On the full page, the address
updates and the browser's Back button returns to the previous article. Back to
the topic list keeps the typed search, and an address with an unknown article
shows the topic list. The phone menu or a dialog that closes does not move the
open article. Other links navigate normally.

An article starts with its app path, title, and first paragraph as a short
answer. One chip row shows “You need <level>” and the step count. A text table
of contents stays at the side in a wide reader and becomes an “On this page”
menu in a narrow reader. The article ends with one large “Next” tile and
related articles in their app colour. Authors choose `next`; article order
only sorts the topic list.

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
`search_help` and `read_help` dynamically through the shared Help service, as
the chat's user. This
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
[Deployment requirements](/en/docs/operations/deployment-requirements#optional-bm25-search-ranking)
for installation and verification. Once the indexes exist, every Postgres
server that runs the database must keep `pg_textsearch` preloaded.

`read_help` and `cloud__help__read` return at most 7,000 characters, selecting
relevant sections when a query is supplied. An exact level-two heading selects
that section. Full article reads in the UI and MCP resources still return the
complete article.

### Agent text and Copy as Markdown

`read_help`, `cloud__help__read`, MCP resource reads, and the Help API's
`markdown` field return portable agent text rather than the Markdown source.
“Copy as Markdown” uses that same field. Search returns metadata only.

| Source | Agent text |
| --- | --- |
| `:kbd[mod+k]` in English | `Ctrl+K (⌘K on Mac)` |
| `:kbd[mod+k]` in German | `Strg+K (⌘K auf dem Mac)` |
| `:kbd[enter]` | `Enter`: a key without a platform modifier reads by its name |
| `**Hide**{icon="eye-off"}` | `**Hide**` |
| `## Hide {icon="eye-off"}` | `## Hide` |
| `:::details Question` … `:::` | `**Question**`, a blank line, and the full body |
| `[text](help:mail/mail-invitations#reply)` | `[text](/help/apps/mail/mail-invitations#reply)` when visible; otherwise `text` |

Other locales use English shortcut explanations. Code spans and fenced code
stay verbatim. Steps, reference, compare, and callout directives remain as
written. The 7,000-character tool-read limit applies after conversion; MCP
resources and the Help API return the complete converted article.

## Who can read Help

Help is for signed-in people. Layout Help, full-page Help, the Help API, the
Assistant, and MCP all read through one shared reader that applies the same
rule, so no surface shows more than another:

- Without sign-in, the Help API answers `401` and full-page Help redirects to
  sign-in. No titles, descriptions, or articles are returned. OAuth clients
  also need the `read` or `admin` scope, as for MCP.
- The reader uses the signed-in user, or the user an API credential acts for. A
  service account without a user sees no Help.
- An application's Help follows its declared visibility. `nav.requiresRoles`
  limits Help exactly like the navigation; `guest` admits guests.
- An application reached only through the admin area, with `adminHref` and no
  own `nav`, shows its Help to administrators.
- Without either declaration, every signed-in user can read the Help,
  including guests. If guests may not use the application, declare
  `requiresRoles: ["user"]`; that hides both its link and its Help from them.

For anyone else, the application's Help does not exist: search returns no
results, and reads and full-page Help answer like a missing article. The
application needs no extra configuration; the declaration it already has for
the navigation decides.

This is visibility, not authorization. The application's routes still decide
who may use the application, and links from Help to protected pages still
authorize normally.

The rule covers the Help that Cloud serves. When an application renders
Markdown from its own declaration, for example with `getMarkdown()`, that text
is part of the application's page and follows the page's route policy. API
Docs does this on purpose: its public page shows its getting-started article to
everyone. Render an article this way only when it may be public.

## Keep the content safe to expose

The Help declaration has no per-article role or authorization callback. Every
article of an application is visible to everyone who may see that application,
so write each article for that whole audience. Registered Help is static
product guidance, not a resource authorization boundary.

Do not include:

- secrets, tokens, internal hostnames, or credentials;
- user, tenant, or resource data;
- role-restricted operational state;
- instructions whose disclosure itself requires a permission check.

Put dynamic or permission-sensitive context in a Query such as `gql.context`.
The Query must authorize every request through the current access subject.

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
It returns `null` without a signed-in user or when the user may not see the
application, so an embedded reader on a public page receives no Help.

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
