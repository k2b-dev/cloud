---
title: Show a resource's Code page
navTitle: Code page
section: Platform services
order: 967
description: Mount the shared Code page at a resource so its administrators see automations, targets, refused calls, runs, versions and switch Code on.
tags: [code, ssr, ui, permissions]
updated: 2026-11-03
---

# Show a resource's Code page

An application whose resource type owns Code (`code.owners`) mounts the shared
Code page at that resource. The page reads Core's public `core.code.*` queries
and activation routes with the person's own credentials, so a built-in and a
third-party application get the same page. It never names an application, and
it never asks another application anything: foreign targets come from the
registry, by type and ID.

## What people see

The page is titled with the feat/code wordmark; screen readers hear whose Code
it is.

- **Overview:** the service account the Code runs as and its handle ("Runs as
  service account “Code of info@example.com” · Handle code-7k2q9m4xwt") with
  **Copy**, also before the first run; Administration › Code shows the same line
  for an app's Code. Then the running version; its automations (schedules and
  manual starts) with status, next run and last run; and its targets as
  operation at target, as written in the Code. Targets say what the Code calls, not whether it
  may: whoever manages a target decides that. A newer version that is ready but
  off marks what it newly calls and offers **Switch on**. A version that waits
  for a Cloud admin says so and cannot be switched on yet. When the newest
  finished run failed with a refused call, **Last run** shows it first (see
  below). Paused Code shows how to resume. Internet origins come from the full
  `manifest.internet` list reviewed with each version, including calls without
  a secret. Running and waiting versions list their own origins; new ones are
  marked. Historical versions show their reviewed list too.
- **Runs:** each run with its trigger, version and state, including skipped
  schedule ticks. A run lists its calls in order with their result. A failed
  run with a refused call shows the refusal in place of the generic failure. A run that
  failed after its first action offers **Run again**, once per failed run; a
  run that failed earlier was already retried by Core. Editors can open any
  failed run in the panel with **View with <panel>**. A run started again says
  "run again by Ben Schulz" in the list and detail and links the failed run
  ("Run again from #2284a1"); a hidden name leaves "run again".
- **Secrets (editors only):** each secret's name, the address, path and headers
  that may receive it, who last set the value and which versions use it; never
  the value. Editors create a secret, replace a value, change a binding or
  delete a value. Replacing needs no approval. A new binding submits a new
  version, and the running version keeps its old binding until that one is
  switched on. A binding change asks for the value again: Cloud never moves a
  stored value to a new address unasked. Deleting always asks first. See
  [Code secrets](/en/docs/platform/code-secrets).
- **Versions:** each version with its approval state, including
  "self-approved (only administrator)", and the selected version's full code
  difference and permissions.
- **Switch on:** a dialog lists every operation at every target the version
  needs, starts Core's durable activation and shows its result. When the person
  does not administer a target, nothing changes and the dialog offers **Copy
  link** to this page for someone who does. A foreign target appears by type
  and ID only, never with its name or who manages it, whatever the refusal
  carries. Phone sessions and non-interactive credentials see why they cannot
  switch on.

Only people who manage the owner and editors or readers of the Code see the
page. Readers see runs without their calls and no actions. Every part that
cannot load shows an error with a way to try again.

Automation names use the optional reviewed `entrypoints[].title` and fall back
to the entrypoint identifier. This also applies to switch-on dialogs. Run
history uses the title from the run's own version.

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
| What Code did to an object | `moved by <FeatCodeMark /> “File invoices”` in the row's text size |
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
