---
title: Show a resource's Code page
navTitle: Code page
section: Platform services
order: 967
description: Mount the shared Code page at a resource so its administrators see automations, access, runs, versions and switch Code on.
tags: [code, ssr, ui, permissions]
updated: 2026-11-01
---

# Show a resource's Code page

An application whose resource type owns Code (`code.owners`) mounts the shared
Code page at that resource. The page reads Core's public `core.code.*` queries
and activation routes with the person's own credentials, so a built-in and a
third-party application get the same page. It never names an application.

## What people see

- **Overview:** who the Code acts as, the running version and who switched it
  on, its automations (schedules and manual starts) with status, next run and last run,
  and its access as operation at target. A newer version that is ready but off
  says which access it newly needs and offers **Switch on**. A version that
  waits for a Cloud administrator says so and cannot be switched on yet.
  Removed access says who removed it at the target and when ("Mia Koch
  removed it today at 11:20"), and which calls fail until someone switches the
  Code on again. A name the viewer may not see in the directory reads as
  "Someone"; without the removal's audit event only the removal itself shows.
  The automation that needs it shows **Access missing**; the others keep
  running. Only the whole Code can be paused. A deleted target, all access
  removed, and paused Code each show what fails and how to recover. Internet
  origins come from the full `manifest.internet` list reviewed with each version,
  including calls without a secret. Running and waiting versions list their own
  origins; new ones are marked. Historical versions show their reviewed list too.
- **Runs:** each run with its trigger, version and state, including skipped
  schedule ticks. A run lists its calls in order with their result. A run that
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
  link** to this page for someone who does. It names the target and who
  manages it only when the person may read that target; otherwise it shows
  only the ID. The page decides this itself, whatever the refusal carries. Phone sessions
  and non-interactive credentials see why they cannot switch on.

Only administrators of the owner and editors or readers of the Code see the
page. Readers see runs without their calls and no actions. Every part that
cannot load shows an error with a way to try again.

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
  `attention`: a warning dot, never a number, when a latest run failed, access
  is missing, or a version waits for approval.

```tsx
import { CodeNavStatus } from "@k2b/cloud/ssr/code-nav-status";

<AppWorkspace.SidebarItem href={`/app/inventory/${store.id}/code`} icon="ti ti-code" meta={<CodeNavStatus attention={attention?.attention ?? false} />}>
  Code
</AppWorkspace.SidebarItem>;
```

The Code page itself always shows the real state.

The same page shows one personal Code: pass `owner: { codeId }` instead of a
resource. Core reads that Code by ID; a Code the person may not see, or Code
of a resource or app, shows the "no access" state. Personal Code runs as its
person, so the page leads with the Code's title, says "runs as you" (or names
the owner when the Code is shared with the viewer) and lists no target access,
because the Code never gets access of its own. Gustav uses this at
`/app/assistant/code/<codeId>`.

A panel that declares `code: true` (see [Offer a panel](/en/docs/platform/panels))
appears as **Edit with <panel>** on the page and on an empty page, with the icon
the panel declares; the page names no application.
