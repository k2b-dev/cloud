---
title: Data ownership
navTitle: Overview
section: Data
order: 400
description: Decide which data belongs to an application and which data belongs to the platform.
tags: [data, postgres, settings, storage]
updated: 2026-08-11
---

# Data ownership

An application owns its domain data.

Most applications store that data in one Postgres schema named after the
application. Cloud owns shared platform data such as accounts, access entries,
settings, notifications, and logs.

This boundary lets a third-party application evolve and release its schema
without migrating Cloud-owned tables. Platform records may identify callers or
hold grants, but the application remains authoritative for its resources.

## Choose the store

| Data | Store |
| --- | --- |
| Domain records and relationships | Application-owned Postgres schema |
| Operator-controlled runtime configuration | Cloud settings |
| One fixed credential for a setting | A `secret` setting |
| Credentials created for users or resources | Encrypted application table |
| Locks, queues, topics and schedules | NATS JetStream through `@k2b/sync` |
| Rate limits and short-lived cache entries | Cloud rate limiting or bounded Valkey caches |
| Large files or shared file trees | External storage, with ownership metadata in Postgres |

Postgres is the default for state that must survive a restart.

NATS coordinates distributed work; Valkey provides bounded caches and rate limits. Durable domain records stay in Postgres.

## Continue by task

| Task | Page |
| --- | --- |
| Query an application-owned schema | [Postgres queries](/en/docs/data/postgres-queries) |
| Choose a stable public identity for a resource | [Public resource identifiers](/en/docs/data/public-resource-identifiers) |
| Change the schema or write atomically | [Migrations and transactions](/en/docs/data/migrations-and-transactions) |
| Place secrets, cache entries, files, and other state | [Secrets and persistent state](/en/docs/data/secrets-and-persistent-state) |
| Link domain resources to platform access | [Resource authorization](/en/docs/identity/authorization) |
| Wrap persistence in domain behavior | [Services and Result](/en/docs/server/services-and-results) |
