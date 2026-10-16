---
title: Secrets and persistent state
navTitle: Secrets and state
section: Data
order: 440
description: Store sensitive configuration and durable application state in the correct platform service.
tags: [data, secrets, encryption, settings, valkey, storage, https, ssrf]
updated: 2026-10-16
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

`secrets.encrypt` uses the same key and format as encrypted settings: JSON
encrypted with AES-256-GCM. Key material comes from trimmed `APP_SECRET`: an
even-length hexadecimal value is used directly; any other value is hashed with
SHA-256. Any application with the same `APP_SECRET` and database access can
decrypt these values. This protects against database-only access, such as dumps
and backups, but does not isolate secrets from other applications in the
deployment.

## Share a secret between applications

All settings rows live in one deployment-wide table, but each key belongs to
the one application that declares it in `defineApp({ settings })`. The typed
`app.settings` API and request snapshot expose only that application's keys and
platform settings. Writes to undeclared keys throw `Unknown setting`.

Do not use a setting for a credential that several applications must read, such
as storage credentials shared by a suite of standalone apps. Use an encrypted
application table instead. One application owns the table: it creates the table
in its migration and writes the rows. The other applications read the rows and
decrypt them with `secrets.decrypt`.

For example, the owner writes a credential and a reader reports missing or
unreadable credentials as an explicit state:

```ts
import { sql } from "bun";
import { secrets } from "@k2b/cloud/services";

// Owner application, after its migration created the table.
const encrypted = await secrets.encrypt({ apiKey: input.apiKey });
await sql`
  INSERT INTO storage.shared_credentials (name, value_encrypted)
  VALUES (${input.name}, ${encrypted})
  ON CONFLICT (name)
  DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted
`;

// Reader application, inside the server operation that needs the secret.
async function readCredential(name: string) {
  const [row] = await sql<{ value_encrypted: string }[]>`
    SELECT value_encrypted FROM storage.shared_credentials
    WHERE name = ${name}
  `;
  if (!row) return { status: "missing" };

  try {
    const credential = await secrets.decrypt<{ apiKey: string }>(
      row.value_encrypted,
    );
    return { status: "ready", credential };
  } catch {
    // The writer used another APP_SECRET. Show this state
    // instead of failing silently.
    return { status: "unreadable" };
  }
}
```

The owner's migration must create `name` as a unique key and `value_encrypted`
as a text column. Keep decrypted credentials on the server.

> Every application that reads the table must run with exactly the same
> `APP_SECRET` value as the writer. With a different value, `secrets.decrypt`
> throws. Start readers only after the owner's setup has created the table.

## Keep the encryption key stable

Every application instance must use the same stable `APP_SECRET`. Cloud has no
built-in rotation or previous-key fallback.

After a key change, `secrets.decrypt` throws for existing encrypted application
values. Settings reads silently ignore rows they cannot decrypt and use
`envFallback` or the default instead.

At startup, Cloud overwrites an unreadable setting when its `envBootstrap`
returns a value from the environment. It encrypts that value with the current
key, losing the old stored value. Examples include `app.url` from `APP_URL` and
`gotenberg.url` from `GOTENBERG_URL`. A single container started with a different
`APP_SECRET` can do this to shared platform settings.

Some applications also derive short-lived signatures from `APP_SECRET`, such as
Grids pagination cursors and Files editor links. Those stop working after a key
change.

Rotating the key requires an offline migration:

1. Stop every application.
2. Decrypt every stored value with the old key and encrypt it with the new key:
   all settings rows and every encrypted application column.
3. Start all applications with the new `APP_SECRET` value.

Cloud has no tool for this migration. Losing the old key makes existing
encrypted values unrecoverable. Back up the key separately from the database
and restrict access to both.

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
- `localhost`, `localhost.localdomain`, `metadata`, `metadata.google.internal`,
  `instance-data`, and names under `.localhost`, `.internal`, `.local`, or
  `.home.arpa`;
- a name with any DNS answer in a private, loopback, link-local, shared,
  documentation, multicast, or other reserved range. One such answer is enough;
- a failed or empty DNS lookup, or an invalid address in its answers.

Every IP literal form is classified, including shortened, decimal, octal, and
hexadecimal IPv4, and IPv4-mapped, IPv4-compatible, NAT64, 6to4, and Teredo IPv6.
Well-known NAT64 addresses are judged by their embedded IPv4 address.

It then connects to the address it checked, without a second lookup, so a DNS
answer that changes in between cannot move the request. TLS still verifies the
certificate for the URL's host name.

For transports `requestPublicHttps` cannot cover, such as IMAP, SMTP, or a
plain-HTTP tester, resolve with `resolvePublicNetworkAddresses` from
`@k2b/cloud/services/network-security`, catch `NetworkTargetBlockedError` for
policy refusals, and connect through `pinnedNetworkLookup(addresses)`. With
`node:http` or `node:https`, also pass `agent: false`, because a default agent
can route through an environment proxy that resolves the name again. This keeps
the connection on the checked addresses; never call `fetch()` with the URL.

### Allow operator-approved internal targets

When an application must reach internal services, declare an explicit allowlist
in its environment registry. Only operators may set it. Never accept allowlist
entries from a person, a base editor, or remote content.

`parseNetworkAllowlist(entries)` from `@k2b/cloud/shared` accepts exact DNS host
names, strict dotted-quad IPv4, IPv6 literals (optionally bracketed), and CIDR
networks. Host names are lowercased and lose their trailing dot. Wildcards,
schemes, ports, paths, userinfo, IPv6 zone IDs, and legacy IPv4 forms are invalid.
CIDR prefixes must be between 1 and the address family's width, with no host
bits set; a `/0` network would allow every address and is refused. An invalid
entry throws an error naming the entry and, for host bits, the correct network.
Entries carry no port or path, so an entry allows every service on that host or
in that range; keep them as narrow as the use case allows.

Use `parseNetworkAllowlistEnv(variable, entries)` from `@k2b/cloud/shared`
for env registry values. It applies the same parser and prefixes errors with
the variable name, so invalid operator configuration is clear at startup.

Pass the parsed `NetworkAllowlist` to
`resolveAllowedNetworkAddresses(hostname, allowlist, lookup?)` from
`@k2b/cloud/services/network-security`, then connect through
`pinnedNetworkLookup` with `agent: false`. An exact host entry trusts every
validated address returned for that name, including internal addresses. Without
a host entry, every answer must be public or in an allowed network. A single
unlisted internal answer refuses the request. Reserved names such as
`localhost`, `.local`, and `.internal` names require an exact host entry, even
when their addresses match an allowed network. Failed and empty lookups still
refuse, including for listed names; they throw an ordinary error rather than
`NetworkTargetBlockedError`. Invalid addresses and unsupported families refuse
even for listed names.

`isAllowlistedNetworkAddress(allowlist, address)` performs pure IP network
matching without DNS. IPv4-mapped IPv6 addresses also match their embedded IPv4
against IPv4 entries. Other embeddings, including NAT64 `64:ff9b::/96`, 6to4,
Teredo, and IPv4-compatible IPv6, require an IPv6 entry. Network entries never
trust host names. `resolvePublicNetworkAddresses` retains the empty-allowlist
policy. Pulse uses this contract for metrics sources and rechecks every
redirect with the same operator allowlist. Notebooks uses it for S3 snapshots:
Bun signs locally, and a pinned transport sends the presigned PUT requests.

For a save-time policy check, use
`isNetworkTargetBlocked(hostname, allowlist, { resolve?, timeoutMs? })` from
`@k2b/cloud/services/network-security` (also exported by `@k2b/cloud/services`).
It returns `true` only for `NetworkTargetBlockedError`. A failed lookup or the
five-second default timeout returns `false`, so an unavailable service can be
saved. The timer is cleared when the check finishes. This hint never permits a
request: resolve, validate and pin again on every run, refusing failed or empty
lookups. `resolve` and `timeoutMs` can be injected for focused tests.

### Read the result

The result contains `status`, a bounded `body` as bytes, and selected response
headers: content-type, retry-after, etag and last-modified.

- An HTTP error resolves with its status and body; the caller decides what it
  means.
- A redirect resolves with its status and an empty body. `Location` is not
  returned, so the caller cannot follow it either.
- A compressed response, a body above `maxBytes`, and a connection or TLS
  failure throw `HTTP_FAILED`, and so does a cancellation after the name
  lookup. A failed lookup and an earlier cancellation throw other errors, so
  treat every thrown error as a failed request. Errors never contain the
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
