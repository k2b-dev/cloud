---
title: Secrets and persistent state
navTitle: Secrets and state
section: Data
order: 440
description: Store sensitive configuration and durable application state in the correct platform service.
tags: [data, secrets, settings, valkey, storage, https, ssrf]
updated: 2026-10-09
---

# Secrets and persistent state

Choose storage by how the value is used, not by its TypeScript type.

## Choose the storage

| Need | Store |
| --- | --- |
| Runtime configuration changed by an operator | Cloud setting |
| One fixed password or API token | `secret` setting |
| Many credentials created at runtime | Encrypted application table |
| Domain data | Application Postgres schema |
| Locks, queues, topics and schedules | NATS JetStream |
| Rate limits or short-lived cache | Valkey |
| Large files or shared file trees | External storage |

Do not store durable domain state in Valkey or container memory.

## Store fixed secrets in settings

Declare a fixed credential with `kind: "secret"`:

```ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  // ...
  settings: {
    "inventory.provider_api_key": {
      kind: "secret",
      label: "Provider API key",
      description: "Authenticates requests to the stock provider.",
      default: "",
      envFallback: () =>
        process.env.INVENTORY_PROVIDER_API_KEY,
    },
  },
});
```

Read it on the server:

```ts
const apiKey = await app.settings.get(
  "inventory.provider_api_key",
);
```

Cloud encrypts persisted settings with `APP_SECRET`.

The admin API redacts `secret` values. Runtime code still receives the
decrypted value, so do not send it to the browser or write it to logs.

Use [Settings](/en/docs/platform/settings) for declarations, request snapshots,
and precedence.

## Keep secrets out of other setting kinds

Do not place a credential inside a `text`, `template`, or JSON setting.

Those values are returned to the admin UI in full. A secret nested inside one
of them appears in page data, browser caches, developer tools, and session
recordings.

Only `kind: "secret"` receives the redacted admin behavior.

## Store growing credentials in an application table

Settings keys are registered when the application starts. They are the wrong
store for one credential per user, connection, or resource.

Keep searchable metadata in normal columns and encrypt only the secret value:

```ts
import { sql } from "bun";
import { secrets } from "@k2b/cloud/services";

const encrypted = await secrets.encrypt({
  apiKey: input.apiKey,
});

await sql`
  INSERT INTO inventory.integration_credentials (
    name,
    value_encrypted
  )
  VALUES (${input.name}, ${encrypted})
`;
```

Decrypt only inside the server operation that needs it:

```ts
const value = await secrets.decrypt<{
  apiKey: string;
}>(row.value_encrypted);
```

Return metadata and a `configured` boolean to the browser. Never return the
encrypted value as a substitute for redaction.

## Keep the encryption key stable

Every application instance must use the same `APP_SECRET`.

Changing or losing it makes stored settings and encrypted application values
unreadable. Back up the key separately from the database and restrict access to
both.

Cloud refuses to start without `APP_SECRET`.

See [Runtime configuration](/en/docs/operations/runtime-configuration) for
container configuration.

## Coordinate work through Sync

Use `@k2b/sync` on NATS JetStream for:

- durable jobs and queues;
- schedulers;
- distributed mutexes;
- topics and live events;
- ephemeral service registration.

Use `ratelimit` from `@k2b/cloud/server` for rate limits.
Use a direct Valkey key only for a bounded cache or protocol that no shared API
owns. Give cache keys a namespace and an expiry.

A missed or evicted cache entry must be recoverable from Postgres or the
external system.

Continue with
[Coordination primitives](/en/docs/automation/coordination-primitives).

## Store large files outside the application container

Container files disappear when the instance is replaced.

Use the Files/Filegate service or S3-compatible storage when blobs are large,
shared, or need independent retention. Keep the resource owner, storage key,
content type, size, and lifecycle state in Postgres.

An upload is not complete until the application has persisted the reference.
Deletion must cover both the stored object and its database reference, with a
recoverable retry when one side fails.

The complete
[Inventory data example](https://github.com/k2b-dev/cloud/blob/main/docs-site/examples/cloud-docs/data.ts)
shows encrypted application credentials.

## Call a public HTTPS address

Use `requestPublicHttps` from `@k2b/cloud/services` for every server-side
request whose destination a person, an administrator, or remote content
chooses: a link preview, a webhook, or an external API called with a stored
credential. `fetch()` would follow such a URL into the installation's internal
network. `requestPublicHttps` sends one bounded HTTPS request to a checked
public address and never follows redirects or retries.

```ts
import { requestPublicHttps } from "@k2b/cloud/services";

const response = await requestPublicHttps({
  url: "https://api.example.com/status",
  method: "GET",
  headers: { accept: "application/json" },
  maxBytes: 64 * 1024,
  signal: AbortSignal.timeout(5000),
});
```

| Field | Meaning |
| --- | --- |
| `url` | An `https:` URL without a user name or password |
| `method` | The HTTP method |
| `headers` | Request headers; Cloud sets `host` and `accept-encoding: identity` |
| `body` | Optional request bytes |
| `maxBytes` | The largest response body; a larger body fails instead of being cut |
| `signal` | Required deadline and cancellation; it also ends a stalled DNS lookup |

### Know what it refuses

Before it opens a connection, `requestPublicHttps` throws for:

- a URL that is not `https:` or carries a user name or password
  (`HTTPS_REQUIRED`);
- a `maxBytes` that is not a whole number of zero or more
  (`INVALID_BYTE_LIMIT`);
- `localhost`, names under `.localhost` or `.internal`, and
  `metadata.google.internal`;
- a name with any DNS answer in a private, loopback, link-local, shared,
  documentation, multicast, or other reserved range, IPv4 addresses mapped
  into IPv6 included. One such answer is enough.

It then connects to the address it checked, without a second lookup, so a DNS
answer that changes in between cannot move the request. TLS still verifies the
certificate for the URL's host name.

### Read the result

The result contains `status`, a bounded `body` as bytes, and selected response
headers: content-type, retry-after, etag and last-modified.

- An HTTP error resolves with its status and body; the caller decides what it
  means.
- A redirect resolves with its status and an empty body. `Location` is not
  returned, so the caller cannot follow it either.
- A compressed response, a body above `maxBytes`, and a network or TLS failure
  throw `HTTP_FAILED`. Cancellation throws as well. Errors never contain the
  request's headers or credentials.

A timeout does not prove that an external mutation failed. Do not
automatically retry uncertain writes; deliver a write that must happen once
through an [outbox](/en/docs/data/migrations-and-transactions#deliver-an-outbox)
with an idempotency key.

### Fetch a URL that someone else chose

Treat the URL and everything it returns as untrusted. Bound each request with
a short deadline and a small `maxBytes`, parse only the bytes you need, and
cache results so that one link is not fetched for every reader. A link that
redirects, or points to an internal or plain-HTTP address, gets no result.

### Send an authorized credential

The caller must authorize the request and the credential's destination,
supply a deadline, and bound the request body. Do not forward Cloud cookies or
invocation tokens.

This transport does not grant access to an application's secrets. Applications
own their authorization and must treat remote response content as untrusted.
An external API can reflect the credential it receives; encryption and
server-side injection do not make arbitrary external services trustworthy.
