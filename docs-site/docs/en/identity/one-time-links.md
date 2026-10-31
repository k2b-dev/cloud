---
title: One-time links
navTitle: One-time links
section: Identity and access
order: 325
description: Create single-use credentials shared by apps in one package and derive app-specific cookie signing keys.
tags: [identity, links, tokens, cookies]
updated: 2026-10-31
---

# One-time links

Use `links` for a credential that an application can redeem once, such as a
customer sign-in or invitation. Your application owns the request form,
authorization, mail, and session. Cloud supplies token generation, expiry,
atomic redemption, and cleanup.

## Create and redeem a link

Call these server-only functions after `app.start()`:

```ts
import { links } from "@k2b/cloud/services";

const { token, expiresAt } = await links.create({
  purpose: "portal.login",
  subject: "mia@example.test",
  ttl: 900,
});

const result = await links.redeem(token, { purpose: "portal.login" });
if (result.ok) {
  const { subject, createdAt } = result.data;
  // Authorize this subject against the application's current customer records.
}
```

The public signatures are:

```ts
import type { TransactionSQL } from "bun";

type LinkOptions = { tx?: TransactionSQL };

links.create(
  input: { purpose: string; subject: string; ttl: number },
  options?: LinkOptions,
): Promise<{ token: string; expiresAt: Date }>;

links.peek(
  token: string,
  input: { purpose: string },
  options?: LinkOptions,
): Promise<
  | { ok: true; data: { subject: string; createdAt: Date; expiresAt: Date } }
  | { ok: false; error: { code: "LINK_INVALID" } }
>;

links.redeem(
  token: string,
  input: { purpose: string },
  options?: LinkOptions,
): Promise<
  | { ok: true; data: { subject: string; createdAt: Date } }
  | { ok: false; error: { code: "LINK_INVALID" } }
>;
```

Cloud also exports `CreateLinkInput`, `CreatedLink`, `RedeemedLink`,
`LinkOptions`, `PeekedLink`, `PeekLinkResult`, and `RedeemLinkResult` from `@k2b/cloud/services`.

| Input | Contract |
| --- | --- |
| `purpose` | Matches `[a-z0-9][a-z0-9.-]{0,63}`; redemption requires the exact purpose used at creation |
| `subject` | App-defined string, at most 1024 UTF-8 bytes; empty strings and null bytes are supported |
| `ttl` | Required, finite seconds from 60 through 2592000 (30 days) |

Invalid creation inputs throw `TypeError` or `RangeError`; fix the caller.
Invalid, malformed, expired, previously redeemed, and wrong-purpose tokens all
return `LINK_INVALID` from both `peek` and `redeem`. Database failures throw; they do not pretend that a
credential was invalid. Applications must show a recoverable error when the
operation cannot complete.

Tokens contain `cl_` followed by 32 cryptographically random bytes encoded as
43 unpadded base64url characters. Cloud stores only the SHA-256 token hash.
The returned dates use the database clock. Redemption checks the current
database time even when the caller's transaction began earlier.

## Record that a link was opened

`links.peek(token, { purpose }, { tx }?)` reads a currently valid link without
consuming it. It returns the subject, creation time, and expiry. Calling it
repeatedly does not prevent a later redemption.

For a link landing page, read the fragment in the browser and remove it from
the address bar before asynchronous work. The page shows only a **Sign in
now** button. On load, POST the token to an app endpoint that uses `peek` to
record “opened” on the app's own record. Pass the transaction handle when the
lookup belongs with that domain write. Do not redeem on page load or on GET;
mail scanners can follow links without the intended person acting.

The button's POST calls `redeem` and establishes the app session. A successful
peek is a snapshot, not a reservation: another request may redeem the link,
or it may expire before the button is pressed. Always handle `LINK_INVALID`
on the final POST. Peek returns that same error for an already used, expired,
wrong-purpose, other-package, unknown, or malformed token.

## Share links within a package

Links belong to the resolved `defineApp({ package })`, which defaults to the
app ID. Apps declaring the same package share links in the reserved
`platform._cloud_links` table, partitioned by package. This table uses the
same Postgres database as the application’s `sql`; Cloud does not infer a
domain schema or use the caller’s `search_path`.
For example, an invoices app and a website app can both declare
`package: "warenfluss"`: invoices creates a link and the website redeems it.
An app in a different package cannot redeem that link through `links`.
Package partitioning separates ordinary app use; it does not isolate apps
that can access the installation database directly.

`purpose` is the namespace inside the package. Agree on prefixes such as
`portal.login` and `invoice.approval` across its apps. A caller must pass the
exact creation purpose to `redeem`; a mismatch leaves the link unused.

Cloud creates the reserved table automatically before application setup and
readiness, including when `skipSetup` is enabled. Applications do not migrate
this table. Creation is serialized across all apps and replicas with a
database advisory lock. The table’s primary key is `(package, token_hash)`.

## Commit redemption with your domain writes

Pass the Bun transaction handle from `sql.begin()` directly. No adapter or
cast is needed. In this example, `portal.customer_sessions` is an
application-owned table with a `subject` column:

```ts
import { sql } from "@k2b/cloud";
import { links } from "@k2b/cloud/services";

const result = await sql.begin(async (tx) => {
  const redeemed = await links.redeem(token, { purpose: "portal.login" }, { tx });
  if (!redeemed.ok) return redeemed;

  await tx`
    INSERT INTO portal.customer_sessions (subject)
    VALUES (${redeemed.data.subject})
  `;
  return redeemed;
});
```

The link becomes used only when the transaction commits. A rollback undoes
redemption and the session insert together. `links.create(input, { tx })`
also rolls back with the caller's transaction. Related apps can use their own
transactions against the shared package table.

Concurrent attempts can commit at most one successful redemption. A caller
that rolls its transaction back has not consumed the link.

## Sign an app session cookie

`appKey` is synchronous and server-only:

```ts
import { appKey } from "@k2b/cloud/server";

appKey(name: string): string;
```

After `app.start()`, it derives 32 bytes with HKDF-SHA-256 from the startup
snapshot's current `APP_SECRET`, uses the **app ID** as salt and `name` as
info, and returns those bytes as an unpadded base64url string. `name` follows
the same syntax as `purpose`. Invalid names or use before startup throw.

The app ID keeps cookie keys separate even when apps share a package and
links. The same app, name, and secret produce the same key across replicas
and restarts. Different apps or names produce different keys.

Pass the string directly to Hono's cookie helpers:

```ts
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { appKey } from "@k2b/cloud/server";

await setSignedCookie(c, "__Host-portal-session", sessionId, appKey("portal.session"), {
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  path: "/",
  maxAge: 3600,
});

const signedSessionId = await getSignedCookie(
  c,
  appKey("portal.session"),
  "__Host-portal-session",
);
```

Issue the cookie after the domain transaction commits. On every request,
validate the session and look up the subject's current customer permissions
in the application's own tables. A signed cookie alone does not grant access.
Use your own session table when you need expiry, revocation, or “sign out
everywhere” before the cookie expires.

Apps share the installation's trust model and `APP_SECRET`. Derived keys
separate purposes and ordinary app use; they do not isolate apps that can
access the installation secret. Rotating the current secret invalidates all
cookies signed with the old derived keys. Previous-secret verification is
not automatic.

## Deliver sign-in links safely

1. Rate-limit the request form with `rateLimit()` from `@k2b/cloud/server`.
   Return the same answer for known and unknown addresses. Check the address
   and send mail in a background job so response time does not disclose which
   customers exist.
2. Put the token in the URL fragment, for example `/portal/confirm#cl_…`.
   Read it in the browser and remove the fragment from the address bar before
   asynchronous work. Require an explicit **Sign in now** button, then POST
   the token to redeem it. This prevents mail
   scanners from consuming a GET link and helps prevent unwanted sign-in.
3. Send through `mail.send()` with the declared `mail:send` platform
   permission. See [Outgoing mail](/en/docs/platform/outgoing-mail).
   The outgoing-mail store retains message text, including the link; use a
   short TTL for sign-in links.
4. Create and validate your own session, using current domain records on every
   request. Cloud does not create sessions, send mail, revoke links, or expose
   a link list through this service.

Cloud redacts `cl_` credentials in structured logs and telemetry, including
path segments, query values in logged strings, and nested metadata under
ordinary keys. HTTP path logging drops the whole query. Keep credentials out
of your logs regardless; see [Logging](/en/docs/platform/logging).

## Operations notes

Every started application ensures that the one reserved
`platform._cloud_links` table exists in its SQL database. No domain schema,
application `setup()`, or environment variable is required.

One shared platform Sync schedule runs hourly in UTC. All apps and replicas
compete for the same serial schedule; cleanup runs once for the shared table,
not separately for each app or package. It deletes rows whose expiry or
redemption is more than 24 hours old, in batches of at most 1000. Each batch has a ten-second SQL statement
budget, and each run has a five-minute budget with cancellation checked
between batches. A failed run retries once after 30 seconds and remains
visible through Sync's schedule status; the next hourly run retries remaining
rows. Cleanup can lag during downtime without making expired links valid.
