---
title: SSR pages and routing
navTitle: SSR pages and routing
section: Frontend
order: 810
description: Render application pages on the server and map them to explicit routes.
tags: [ssr, routing, solidjs]
updated: 2026-08-30
---

# SSR pages and routing

An SSR page loads authorized data and returns a synchronous SolidJS render
function.

## Render a page

```tsx
import { Layout } from "@valentinkolb/cloud/ssr";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { ssr } from "../config";

export default ssr<AuthContext>(async (c) => {
  const accessSubject = c.get("accessSubject");
  const url = new URL(c.req.url);
  const items = await inventory.list({
    accessSubject,
    search: url.searchParams.get("search") ?? undefined,
  });

  c.get("page").title = "Inventory";

  return () => (
    <Layout c={c} title="Inventory">
      <InventoryPage items={items} />
    </Layout>
  );
});
```

Load data, redirect, and set metadata before the returned function.

The returned function must be synchronous. Solid SSR creates JSX inside
`renderToString()`.

The framework resolves the request locale into `c.get("page").lang` and the
document's `<html lang>` attribute for every SSR page. `Layout`, `AdminLayout`,
and `MinimalLayout` provide the same value to `@k2b/ui` components, and browser
islands inherit it from the document. Use `MinimalLayout` for an app-styled
standalone root that still needs Cloud's persisted locale, theme, and timezone
wiring. A deliberately custom root that uses none of these layouts must wrap
its returned component tree once with `LocaleProvider` from `@k2b/ui`, using
`getLocale(c)`. See [Internationalization](/en/docs/build/internationalization)
before formatting or translating values in a page.

## Authorize page data

An SSR page calls a service directly. API route middleware does not run for
that call.

Pass `accessSubject` into the service and repeat every resource permission
check needed for the rendered data.

Use `expectUserBackedActor(c)` only when the page truly requires a user. A
resource-bound service account has no user.

See [Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization).

## Map routes explicitly

```ts
import {
  type AuthContext,
  auth,
} from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import detailPage from "./detail/page";
import listPage from "./page";

export default new Hono<AuthContext>()
  .get(
    "/",
    auth.requireRole("user", auth.redirectToLogin),
    ...listPage,
  )
  .get(
    "/:id",
    auth.requireRole("user", auth.redirectToLogin),
    ...detailPage,
  );
```

The file tree does not create routes. Spread the middleware array returned by
`ssr()`.

Register fixed routes before dynamic or catch-all routes.

## Serve anonymous pages

Use an application-owned prefix such as `/share/inventory`. Add it to
`defineApp().routes`.

`/public/<app>` is reserved for generated static assets. Application pages
registered there are not reached.

Use `auth.requireRole("*")` when a page accepts both anonymous and signed-in
requests. That middleware does not grant resource access. Validate the share
token or public grant in the service.

Choose `Layout` when the page should retain recognizable Cloud navigation.
Choose `MinimalLayout` when the application owns the complete visual surface.
Neither choice changes route or resource authorization.

## Verify the page

Test the page route with and without a valid session. Verify denied data never
appears in the HTML.

The page must remain correct on reload and without JavaScript. Islands are an
enhancement, not the only rendering path.
