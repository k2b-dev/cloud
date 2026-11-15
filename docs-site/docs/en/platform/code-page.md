---
title: Show a resource's Code page
navTitle: Code page
section: Platform services
order: 967
description: Mount the shared Code page at a resource so its administrators see automations, targets, refused calls, runs, versions and switch Code on.
tags: [code, ssr, ui, permissions]
updated: 2026-11-14
---

# Show a resource's Code page

An application whose resource type owns Code (`code.owners`) mounts the shared
Code page at that resource. The page reads Core's public `core.code.*` queries
and activation routes with the person's own credentials, so a built-in and a
third-party application get the same page. It never names an application, and
it never asks another application anything: foreign targets come from the
registry, by type and ID.

## What people see

The page shows what the Code does, in words. It shows no source except in the
editors' **Code** tab. Targets are named for the person who reads them, or by
their type ("a space you cannot see").

- **Head:** the state as one large word with its sign (Switched on; Switched
  on, needs you; Paused with **Resume**; Not switched on yet), one quiet line
  with the place and the running version, **Change with <panel>** and a **…**
  menu. The menu offers pause or resume, **Copy handle** of the service
  account, **Copy link** and, for editors, **Get the source locally**, which
  shows the `cld code pull` command.
- **Tabs** in one row: Overview, Runs, Secrets (editors), Versions and Code
  (editors). The tab is in the address (`?tab=`), so reload and back return to
  it.
- **Overview:** the description Gustav wrote for the version, marked as not
  checked by Cloud; the situation (next run, last run and a strip of the last
  30 runs, each a link to its run); **What it did for you** this week, with
  counts and the last effects (resource Code only; the page reads each
  effect's target with the reader's own rights, at most six, and names and
  links only what they may open); **When it runs** with
  **Run now**; and **What it may do** (apps, internet and its own data in one
  list; a target is named and linked only when the reader may open it, read
  the same way as the effects). A newer version that waits shows the shared approval frame above the
  situation. When the last run failed, a notice says what happened and what
  to check. Run updates arrive live; see [Follow run updates](#follow-run-updates).
- **Runs:** a list with filters (all, failed, skipped) and a detail that says
  in words what happened. A failed run explains its reason and offers **Run
  again …**, which first shows what the run already changed. No run number or
  function name appears.
- **Secrets (editors only):** each secret, the address that may receive it,
  **Stored** or **No value** with what that means, and the dialogs to enter,
  replace or delete a value. Never the value. See
  [Code secrets](/en/docs/platform/code-secrets).
- **Versions:** each version with its state word, and for the selected one
  what changed in access and triggers, Gustav's description and its examples.
  `?tab=versions&version=<id>` opens that version.
- **Code (editors only):** the source of the switched-on version, read only,
  in a fixed-height field that scrolls. **Compare with** chooses an earlier
  version and shows the difference with its added and removed lines; the files
  stand in the field's bar. File and comparison are in the address
  (`?tab=code&file=…&compare=<version>`). Readers and Cloud admins without the
  editor right get no tab, and `?tab=code` opens the overview for them; Core's
  `code.source.tab` query refuses them too.
- **Switch on:** a dialog lists every operation at every target the version
  needs, starts Core's durable activation and shows its result. Phone sessions
  and non-interactive credentials see why they cannot switch on.

Only people who manage the owner and editors or readers of the Code see the
page. Readers see runs without their calls and no actions. Every part that
cannot load shows an error with a way to try again, and says that loading
changes nothing about the automation.

Automation names use the optional reviewed `entrypoints[].title`. Without a
title, an event reads by its title and place, a page by its method and path,
and a schedule by when it runs ("Mondays 08:00", or a one-time date and time
with its zone). Anything else shows its entrypoint identifier. Switch-on
dialogs, the chat version card and Administration › Code use the same names.
A run reads by the title from its own version, else as the listed automation
with the same entrypoint, else by its identifier.

Server read models and browser surfaces share `describeCodeSchedule(cron, locale)`
and `describeCodeTiming({ cron?, at?, timeZone? }, locale)` from
`@k2b/cloud/code/schedule`. The latter formats a one-time instant with its
zone, otherwise the repeating schedule, or returns `null` without a schedule.
Unrecognized cron shapes stay verbatim. These pure helpers need no SSR runtime;
the existing `@k2b/cloud/ssr/code-schedule` entry re-exports the same functions.

## Refused calls

The page reports a refused call like cron reports a failed job: what the Code
tried, as a fact, never as the run's cause. The Code may have caught the
refusal and failed for another reason, so the notice appears only on a failed
run, and a successful run never shows one. The source is what the bridge
recorded at the run (see [Code runs](/en/docs/platform/code-runs)): the first
target refusal (`firstRefusedCallOrdinal`, `firstRefusedCall`) and each call's
`refusalKind`. The page never guesses from a status or an error code.

| Recorded kind | Editors see | Readers see |
| --- | --- | --- |
| `target_refused` (403 or 404) | "No access to Space k7qm2x9a." with the action title, and "Either the service account “Code of …” lacks the right for it, or the target does not exist." Then **Copy handle** and the hint for whoever manages the target, ending "The next run tries again." | "A call was refused." and that everyone who may edit the Code sees which target refused. |
| `policy` | "The policy does not allow this." with action and target. No handle, no hint for the target. | Nothing: readers get no calls. |
| `approval` | "This version needs the Cloud admin's approval." with action and target; Cloud admins also get **View approval**. No handle. | Nothing. |

A target appears by type and ID. Its ID is a link only when the type's
`pages` pattern needs nothing but `:id`, such as `/app/spaces/:id`; a pattern
that also needs another value, such as `/app/spaces/:space?item=:id`, or a
type without pages leaves the ID as text. The target's app shows its name on
its own page, to whoever may read it. Action title, type name and icon come
from the manifest in the registry, without a call. Editors' page load reads
the refused call once from Core; readers' page data never contains it,
because a target ID can come from data at run time.

Whoever manages the target adds the service account with the handle in the
target's access editor. There is no access request: the Code's author asks
the target's manager in their own way and passes the handle.

## Mount it

Mount the page at `<resource's open link>/code`. The chat's version card and its
**Copy link** build the address this way from the link your reader returns.
Check that the person may read the resource, then load the page on the server
and render it in an island:

```tsx
import { Layout, loadCodePage } from "@k2b/cloud/ssr";

const ref = { type: "inventory.store", id: store.id };
const code = await loadCodePage(c, {
  owner: { ref, title: store.name },
  href: `/app/inventory/${store.id}/code`,
  // The owner app decides who administers the resource; Core checks it again on every change.
  canManageOwner: permission === "admin",
});
return () => (
  <Layout c={c} context={{ scope: ref }}>
    <StoreCode code={code} />
  </Layout>
);
```

```tsx
// StoreCode.island.tsx
import CodePage, { type CodePageData } from "@k2b/cloud/ssr/code-page";

export default function StoreCode(props: { code: CodePageData }) {
  return <CodePage data={props.code} />;
}
```

Import the page from its own entry, `@k2b/cloud/ssr/code-page`, so other
islands do not load its schemas. `loadCodePage` reads the tab and selection from the URL (`?tab=runs&run=<id>`,
`?tab=secrets&secret=<name>`, `?tab=versions&version=<id>`), so reload, back and shared links keep the view.

## Say where the page lives

Declare the mount so links to Code lead to it, for example from the history of
what the Code changed in another application:

```ts
code: { owners: ["store"], pages: { store: "/app/inventory/{id}/code" } },
```

Without it, those links open the resource itself.

## Show the entry in your navigation

Offer the page as a "Code" entry under the resource. During SSR, call
`loadCodeAttention(c, ref)` from `@k2b/cloud/ssr`: one `core.code.attention`
query, which Core answers from a short cache. It resolves to
`{ visible, attention }`, or `null` when Core does not answer within its
timeout; it never throws. Start it before your own loads and do not wait for
it much longer than for them, so a slow Core only leaves the dot out.

- Show the entry to the resource's administrators, and to anyone for whom
  `visible` is true.
- Put `CodeNavStatus` from `@k2b/cloud/ssr/code-nav-status` in the entry's
  `meta` with `attention`. It renders `AppWorkspace.SidebarItemStatus`
  `attention`: a warning dot, never a number, when Core reports that the Code
  needs attention, such as a failed latest run or a version waiting for
  approval.

- Use the feat/code sign as the entry's icon, in the text colour of the row.

```tsx
import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { CodeNavStatus } from "@k2b/cloud/ssr/code-nav-status";

<AppWorkspace.SidebarItem href={`/app/inventory/${store.id}/code`} meta={<CodeNavStatus attention={attention?.attention ?? false} />}>
  <AppWorkspace.SidebarItemIcon>
    <FeatCodeMark variant="glyph" tone="current" decorative />
  </AppWorkspace.SidebarItemIcon>
  <AppWorkspace.SidebarItemLabel>Code</AppWorkspace.SidebarItemLabel>
</AppWorkspace.SidebarItem>;
```

The Code page itself always shows the real state.

The same page shows one personal Code: pass `owner: { codeId }` instead of a
resource. Core reads that Code by ID; a Code the person may not see, or Code
of a resource or app, shows the "no access" state. Personal Code runs as its
person, so the page leads with the Code's title, says "runs as you" (or names
the owner when the Code is shared with the viewer) and lists no targets,
because the Code never gets access of its own. A refused call there says that
the person it runs as lacks the right, or that the target does not exist. Gustav uses this at
`/app/assistant/code/<codeId>`.

A panel that declares `code: true` (see [Offer a panel](/en/docs/platform/panels))
appears as **Edit with <panel>** on the page and on an empty page, with the icon
the panel declares; the empty page also says that the panel writes the Code with
the person. The page names no application.

The account handle has one source in the shared page data:
`state.code.serviceAccountHandle`. The loader retains Core’s
`Code.serviceAccountHandle` for both the account line and refusal notices.
Administration reads the same handle for app Code. An unavailable handle hides
the copy action; personal Code has no service-account handle.

## Show the feat/code brand

feat/code is the name of Code in Cloud. Its sign is the slash of the name: a
small commit graph with an origin commit (ring) and a new commit (dot). Show it
wherever people meet Code, with `FeatCodeMark` from `@k2b/cloud/code/ui`:

| Place | Use |
| --- | --- |
| Head of a Code area | `<FeatCodeMark size={30} />` |
| Navigation entry, tab, menu | `<FeatCodeMark variant="glyph" tone="current" decorative />` next to the label "Code" |
| What Code did to an object | `moved by <FeatCodeMark /> “File invoices”` in the row's text size, only when the origin is known to be Code; other work keeps its own name |
| Favicon or app icon | `@k2b/cloud/code/feat-code.svg` |

- `variant` is `wordmark` (default) or `glyph`, the square sign for icon slots.
- `size` is the font size of the wordmark or the edge of the glyph in pixels.
  At 16 px and below, and without `size`, the mark uses a drawing for small
  sizes: ring and dot of the same size and a shorter stroke, so it does not
  read as a needle.
- `tone="brand"` (default) colours only the new commit green, never a
  surface. `tone="current"` draws the whole sign in the text colour, as the
  icons of tabs and menus.
- The mark is an image named "feat/code" for screen readers. Pass
  `decorative` when visible text next to it already names Code.

The mark never wraps and keeps its size in every state. The name stays
"feat/code" in every language.

## Zugriff prüfen

Every signed-in person can reach a private Code route. Start with `app.use()`
before protected routes to check `c.user` once for their shared access rule.
Return 403 to deny or `return next()` to continue. Use a private path prefix
when the app also serves public routes: matching middleware runs there too,
with `c.user === null`. Resource page templates deny
access until you fill their allowed group IDs. Public routes always receive
`c.user === null`. See [explicit UID, handle, group and Grids checks](code-sdk.md#check-access).

## Webhooks (R1: ohne Secret)

An R1 webhook is a public POST route. It receives no incoming request headers,
cookies or visitor identity and needs no CSRF token. R1 does not verify
signatures; signed webhooks follow later. **ID nehmen → beim Dienst nachlesen → handeln**:
take only the ID from the body, read the real state through `http.fetch` with
an opaque secret marker and declared origin, then act. Never put a secret in
the source or use a URL token as protection. Let `/hooks/` through a global
access middleware, or apply the access check only to a private prefix.
See the [complete example and secret binding](code-sdk.md#webhooks-without-signature-verification).

## Database storage and export

The Code page shows its database size and limit together with the owner's
reserved capacity. Editors and Cloud administrators get an **Export SQLite
database** control for an existing database. The download uses the same
permission-aware service as `cld code db export`; ordinary readers cannot
export. See [Code storage](/en/docs/operations/code-storage) for limits and
database lifecycle.

`CodeDatabaseStatus`, exported from `@k2b/cloud/ssr/code-page`, renders this
status for Code and administrator details. Pass `codeId`, the authorized
`database` usage object.
It inherits the UI locale. `canExport` controls presentation only; the export
service checks permission again.

When an inactive Code's latest and selected versions no longer declare
`database`, its owner and editors see “This database will be deleted on …”.
The default grace period is 30 days. **Export SQLite database** saves a copy;
**Delete now** asks for confirmation and is available to editors and Cloud
administrators. A refused or uncertain request leaves a reload action to check
the current state. Reactivation or a database declaration ends the deadline.

The deletion date stays visible for at least the seven-day reminder period.
Shortening or re-enabling retention recalculates it with that same advance
notice; the Code page and administrator list show the same stored date.

The authorized `database.unused` snapshot contains `since`, nullable `deleteAt`
(null when automatic deletion is disabled), `namespace` and `canDelete`.
`CodeDatabaseStatus` shows this notice and `CodeDatabaseDelete` supplies the
confirmed control on administrator lists. Both inherit the UI locale.
`POST /api/code/authoring/database/delete` takes `{ codeId, namespace, since }`
and binds confirmation to that exact database incarnation and unused period.
The service rechecks editor or administrator permission and refuses a changed
or in-use database with `409`. Repeating an accepted request is idempotent.

## Follow run updates

An island can follow run hints from Core even when its page belongs to another
application:

```ts
import { followCodeRuns } from "@k2b/cloud/ssr/code-live";

const stop = followCodeRuns(codeId, (event) => {
  // Animate the run or invalidate its authorized snapshot.
  animateRun(event.runId, event.state, event.at);
}, async () => {
  await reloadRunSnapshot();
});
// Call stop() when the island is disposed.
```

The optional third callback reloads canonical state once after admission and
on `resync`; it receives no event. Without it, resync uses the guarded page
reload and offers a manual reload when that guard prevents another automatic reload. Revocation
or a terminal live failure also uses this recovery path. Reconnects and replay
belong to the platform client. Repeated hints are possible, so animations must
be idempotent. Effect counts refresh with the run's completion hint
(`succeeded` or `failed`); individual effect calls produce no hint. `runId`
identifies the snapshot to refresh, and `at` identifies when Core produced the hint.

A fourth argument takes the live position the page's snapshot belongs to: read
`aiLive.cursor()` on the server before the page's first read and pass it on, so
a run that finishes in between still arrives. Without a position, the callback
covers that gap once after admission. The shared Code page does both by itself;
a host only passes `onLive` to replace that wiring.
See [Core's live channel contract](/en/docs/automation/live-updates#define-the-updates)
for admission rules and the event schema. The helper validates each hint
before calling `onRun`.
