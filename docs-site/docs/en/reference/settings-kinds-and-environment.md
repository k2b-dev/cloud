---
title: Settings kinds and environment
navTitle: Settings reference
section: Reference
order: 1230
description: Look up supported setting kinds, defaults, validation, and environment behavior.
tags: [settings, environment, validation]
updated: 2026-09-10
---

# Settings kinds and environment

Every application setting has a dotted key, kind, and default.

The kind determines the TypeScript value, validation, and administration
control.

## Definition fields

| Field | Required | Contract |
| --- | --- | --- |
| `kind` | Yes | Determines the value type and validation |
| `default` | Yes | Value used when no persisted value or valid environment fallback exists |
| `label` | No | Label in administration forms; Cloud derives one from the key when omitted |
| `description` | No | Explanation shown to operators |
| `placeholder` | No | Input hint for string-like, number, and list settings |
| `envFallback` | No | Server-side function that returns a fallback value |
| `envBootstrap` | No | Server-side function that can create the initial persisted value |

`template` also accepts `templateVars`. `enum` requires `options`, an array of
`{ value, label }`. `number` accepts `min` and `max`.

Environment resolvers run in the server process. Do not expose their source or
secret values to browser code.

## Setting kinds

| Kind | Value | Validation |
| --- | --- | --- |
| `string` | `string` | Text |
| `text` | `string` | Multiline text |
| `email` | `string` | Empty or email address |
| `url` | `string` | Empty or absolute URL |
| `secret` | `string` | Encrypted at rest; redacted from administration responses |
| `image` | `string` | Empty or absolute URL |
| `boolean` | `boolean` | Boolean |
| `number` | `number` | Finite number with optional `min` and `max` |
| `enum` | `string` | One declared option |
| `string_list` | `string[]` | Trimmed, unique values |
| `number_list` | `number[]` | Unique positive integers |
| `cron` | `string` | Five-field cron expression |
| `timezone` | `string` | Empty or valid IANA time zone |
| `template` | `string` | Valid Liquid template |

List inputs accept arrays or comma- and newline-separated text.

## Setting key ownership

Use `<app-id>.<name>` for application settings.

Platform settings are declared once in Cloud. Application settings belong in
that application's `defineApp({ settings })`.

Registering the same key with a different kind, default, minimum, or maximum is
an error.

## Resolve a value

Cloud resolves a setting in this order:

1. a valid encrypted database value;
2. `envFallback`;
3. the code default.

The public setting entry reports `custom`, `env`, or `default` as its source.

At startup, `envBootstrap` writes a custom value when no persisted row exists.
It runs again after that row is removed. Use it only to import an existing
deployment value into Cloud.

## Read and write values

Inside a request, use the frozen `c.get("settings")` snapshot.

Outside a request, use the typed `app.settings` API:

```ts
const limit = await app.settings.get("inventory.export_limit");
await app.settings.set("inventory.export_limit", 500);
await app.settings.remove("inventory.export_limit");
```

Removing a custom value reveals the environment fallback or default.

Writes validate, encrypt, store, and invalidate the shared Valkey cache.

## Separate process environment

Infrastructure variables such as `DATABASE_URL`, `REDIS_URL`, `APP_SECRET`,
`APP_ID` are not settings. Built-in services use port 3000; `PORT` is no longer runtime configuration.

See [Runtime configuration](/en/docs/operations/runtime-configuration) for
their deployment contract and [Settings](/en/docs/platform/settings) for usage.
