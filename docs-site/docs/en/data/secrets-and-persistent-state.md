---
title: Secrets and persistent state
navTitle: Secrets and state
section: Data
order: 440
description: Store sensitive configuration and durable application state in the correct platform service.
tags: [data, secrets, encryption, settings, valkey, storage, https, ssrf]
updated: 2026-10-22
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
import { sql } from "@k2b/cloud";
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
import { sql } from "@k2b/cloud";
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

> Every application that reads the table needs a ring containing the writer's
> root. Without it, `secrets.decrypt` throws. Start readers only after the owner's setup has created the table.

## Declare encrypted data for rotation

Every application that owns encrypted table columns declares them once at
startup. Settings are already covered by Core's platform owner; do not declare
application settings again.

```ts
import { createSecretOwner } from "@k2b/cloud/services";

await app.start({
  fetch: router.fetch,
  secretOwners: [createSecretOwner({
    id: "integration-credentials",
    table: "inventory.integration_credentials",
    primaryKey: ["id"],
    columns: ["value_encrypted"],
  })],
});
```

Use a stable owner ID, the complete primary key in its database order, and all
ciphertext columns of that row. SQL identifiers are lowercase identifiers, and
the table is schema-qualified. The table and columns must exist after the app's
setup. Every retained non-null, nonempty value is checked, including disabled
records. Null and empty lifecycle sentinels are left alone. All listed columns
are replaced in one compare-and-swap statement; one unreadable value leaves the
whole row unchanged. Domain timestamps, revisions and expiry remain unchanged.
If a table has an update trigger, its owner must ensure ciphertext-only rewrap
does not count as a domain edit.

If the application caches these rows, provide
`invalidate: async (row) => invalidateCredentialCache(row.key[0]!)`.
`row.key` contains the primary-key values as strings in declaration order.
Invalidation runs after commit and repeats on already-current rows while
PREVIOUS is configured, covering a crash between commit and invalidation. It
must be idempotent. Without an owning cache, omit it. No decrypted values or
ciphertext are sent through registry metadata or NATS.

For a custom store, `SecretOwner` from `@k2b/cloud/services` supplies the same
contract: `id`, `scan(after, limit)`, `compareAndSwap(row, values)`, and optional
`invalidate(row)`. `scan` returns bounded, consistently ordered pages of
`{ key: string[], values: Record<string, string | null> }`; only ciphertext
belongs in `values`. CAS must compare every old ciphertext and the complete
primary key, preserve domain metadata, and return false when a concurrent edit,
delete or payload clear wins. Resolve CAS only after its database commit.
The framework decrypts and re-encrypts raw plaintext without parsing domain JSON.
It scans one page of at most 100 rows per registry maintenance heartbeat, rotates
between owners, retries failed pages, and drains accepted work during shutdown.
A failed owner does not block later owners. Completed checks retain the pass's
start time; strict rotation status requires that start to follow every instance's
ring change plus the registry instance TTL, as described in the rotation guide.

Declare `secretOwners: []` when the app owns no durable ciphertext. Omission
means unknown, so strict rotation status cannot certify that app.
The framework and Gateway use `createSecretMaintenance` for this lifecycle;
applications normally use the `app.start()` declaration above. Core supplies
`platformSecretOwners()` for shared settings, AI credentials, outgoing mail,
notifications and storage buckets. These platform owners run only under Core.

## Keep the encryption roots recoverable

Readers try current, then PREVIOUS or NEXT. Writers use current. The legacy
ciphertext format and hex/passphrase normalization stay unchanged.
Follow [Rotate APP_SECRET](/en/docs/operations/app-secret-rotation) before
changing the root; Core and Gateway consume its environment ring and other
apps inherit the complete ring through bootstrap unless locally pinned.

When no configured root can read a value, `secrets.decrypt` throws. Settings
reads use the environment fallback or default, preserve the stored row, and
report it as unreadable. Writes still require explicit replacement intent.
Keep recovery roots separately from database backups. An old backup can still
need a root that the running installation has retired.

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
certificate for the URL's host name. A response above `maxBytes` is stopped
with `HTTP_TOO_LARGE`, including when its declared content length already
exceeds the limit. Connection and response failures use `HTTP_FAILED`.

Keep the same deadline signal for the entire operation, including DNS,
connection attempts, redirects handled by the caller, response headers and body
reads. Receiving occasional bytes does not restart that budget. Cancellation
closes both the active request and response. A redirect or rejected response
whose body is unused is destroyed immediately; it is never drained after the
operation settles. A DNS lookup that cannot be cancelled may finish later, but
its answer cannot start a request after cancellation.

Specialized transports can use the lifecycle helpers from
`@k2b/cloud/services/network-transport`: `withNetworkDeadline(timeoutMs,
callerSignal, timeoutError, work)` supplies one signal and clears its timer and
caller listener when work settles; `awaitNetworkOperation(promise, signal)`
bounds an uncancellable lookup. `readNetworkResponse({ request, options, signal,
body?, read })` consumes an already validated and pinned HTTP request and closes
both streams on success, failure or abort. Its `read(response, resolve, reject)`
callback decides which status and body to accept. These helpers do not authorize
an address: resolve through the network guard and preserve the pinned options.

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
entries from an ordinary person, a base editor, or remote content. Pulse instead
uses Cloud-admin-managed internal targets per base; its editors cannot widen them.

`parseNetworkAllowlist(entries)` from `@k2b/cloud/shared` accepts exact DNS host
names, strict dotted-quad IPv4, IPv6 literals (optionally bracketed), and CIDR
networks. `host:port` and `[ipv6]:port` restrict a DNS name or IP to one port,
from 1 to 65535 without leading zeros. Host names are lowercased and lose their
trailing dot. Wildcards, schemes, paths, userinfo, IPv6 zone IDs, legacy IPv4
forms, and CIDRs with ports are invalid.
CIDR prefixes must be between 1 and the address family's width, with no host
bits set; a `/0` network would allow every address and is refused. An invalid
entry throws an error naming the entry and, for host bits, the correct network.
Bare hosts, IPs and CIDRs allow every port; port-restricted entries apply only
when the caller supplies that effective port. Entries never restrict paths.
Keep releases as narrow as the use case allows.

Use `parseNetworkAllowlistEnv(variable, entries)` from `@k2b/cloud/shared`
for env registry values. It applies the same parser and prefixes errors with
the variable name, so invalid operator configuration is clear at startup.

For other transports, call `resolveAllowedNetworkAddresses(hostname, allowlist,
lookup?, port?)`. Without `port`, only bare entries apply. SMTP, IMAP and
Notebooks snapshots pass their selected port.

For HTTP targets, use `createAllowedNetworkFetch(allowlist, deps?)` from
`@k2b/cloud/services`. It returns `(input: string | URL | Request, init?: RequestInit)
=> Promise<Response>`, normalizes method, headers and body through `Request`,
and supports streaming uploads and responses, including SSE and exports.
A body of known size goes out with `Content-Length`, like `fetch()`; only a
`ReadableStream` body is sent chunked.
Only HTTP and HTTPS are accepted; URL user information is refused before I/O.
Each request passes its effective port (80 or 443 when omitted), resolves once
through the guard and connects through
`pinnedNetworkLookup` with `agent: false`, preserving the URL Host header and
HTTPS server name. A `NetworkTargetBlockedError` propagates unchanged; failed
and empty DNS lookups also refuse.

The transport never follows redirects: `redirect: "error"` rejects a 3xx;
otherwise it returns that response unchanged, even with `redirect: "follow"`.
It sends `Accept-Encoding: identity` and rejects any non-identity response
encoding. The returned real `Response` preserves status, status text and all
headers, including repeated values; HEAD, 204 and 304 have null bodies.
`init.signal` or the input Request's signal covers lookup, connection and body
streaming; abort or body cancellation destroys the socket. Callers own deadlines,
byte limits and retries: the helper adds none. Consume or cancel each response
body. Optional `deps.lookup`, `deps.resolve` and `deps.request` support focused
tests without changing the transport policy.

Pass the parsed `NetworkAllowlist` to
`resolveAllowedNetworkAddresses(hostname, allowlist, lookup?, port?)` from
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

`isAllowlistedNetworkAddress(allowlist, address, port?)` performs pure IP network
matching without DNS. IPv4-mapped IPv6 addresses also match their embedded IPv4
against IPv4 entries. Other embeddings, including NAT64 `64:ff9b::/96`, 6to4,
Teredo, and IPv4-compatible IPv6, require an IPv6 entry. Network entries never
trust host names. `resolvePublicNetworkAddresses` retains the empty-allowlist
policy. Pulse uses this contract for metrics sources and rechecks every
redirect using a fresh read of the base’s Cloud-admin-managed targets and the
hop’s effective port. Notebooks uses it for S3 snapshots:
Bun signs locally, and a pinned transport sends the presigned PUT requests.

For a save-time policy check, use
`isNetworkTargetBlocked(hostname, allowlist, { resolve?, timeoutMs?, port? })` from
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
- A body above `maxBytes` throws `HTTP_TOO_LARGE`.
- A compressed response or a connection or TLS failure throws `HTTP_FAILED`,
  and so does a cancellation after the name
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
