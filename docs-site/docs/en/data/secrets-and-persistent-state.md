---
title: Secrets and persistent state
navTitle: Secrets and state
section: Data
order: 440
description: Store sensitive configuration and durable application state in the correct platform service.
tags: [data, secrets, settings, valkey, storage]
updated: 2026-07-27
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
import { defineApp } from "@valentinkolb/cloud";

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
import { secrets } from "@valentinkolb/cloud/services";

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

Use `ratelimit` from `@valentinkolb/cloud/server` for rate limits.
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
[Inventory data example](https://github.com/ValentinKolb/cloud/blob/main/examples/cloud-docs/data.ts)
shows encrypted application credentials.
