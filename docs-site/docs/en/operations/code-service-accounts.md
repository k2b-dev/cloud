---
title: Code service-account migration
navTitle: Code service accounts
section: Operations
order: 1252
description: Roll out the credential-free Code account kind while preserving existing accounts and creator references.
tags: [operations, identity, service-accounts, migrations]
updated: 2026-10-31
---

# Code service-account migration

Roll out Core before applications that create `code` service accounts. Core's
startup migration adds the kind without changing existing accounts or mandates.
Code accounts cannot hold credentials or admin grants. Storage guards enforce
both rules during insertion, updates, and account reclassification, and confine
`app_key` credentials to `cloud.app` accounts. Existing standalone and agent
credentials keep their behavior. Creator references on accounts and mandates
remain nullable and use `ON DELETE SET NULL`.

See [Code accounts](/en/docs/identity/service-accounts#code-accounts) for the
application-side grant and credential checks.
