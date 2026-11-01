---
title: Show a resource's Code page
navTitle: Code page
section: Platform services
order: 966
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
  on, its automations (schedules and manual starts) with status and last run,
  and its access as operation at target. A newer version that is ready but off
  says which access it newly needs and offers **Switch on**. A version that
  waits for a Cloud administrator says so and cannot be switched on yet.
  Removed access, a deleted target, all access removed, and paused Code each
  show what fails and how to recover.
- **Runs:** each run with its trigger, version and state, including skipped
  schedule ticks. A run lists its calls in order with their result. A run that
  failed after its first action offers **Run again**, once per failed run; a
  run that failed earlier was already retried by Core.
- **Versions:** each version with its approval state, including
  "self-approved (only administrator)", and the selected version's full code
  difference and permissions.
- **Switch on:** a dialog lists every operation at every target the version
  needs, starts Core's durable activation and shows its result. When the person
  does not administer a target, nothing changes; the dialog names the target
  and offers **Copy link** to this page for someone who does. Phone sessions
  and non-interactive credentials see why they cannot switch on.

Only administrators of the owner and editors or readers of the Code see the
page. Readers see runs without their calls and no actions. Every part that
cannot load shows an error with a way to try again.

## Mount it

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
`?tab=versions&version=<id>`), so reload, back and shared links keep the view.
Offer the page in your navigation to the resource's administrators. Others
with access to its Code reach it by link or from the panel.

A panel that declares `code: true` (see [Offer a panel](/en/docs/platform/panels))
appears as **Edit with <panel>** on the page and on an empty page.
