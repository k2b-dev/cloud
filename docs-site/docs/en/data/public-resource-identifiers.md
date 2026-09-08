---
title: Public resource identifiers
navTitle: Public resource IDs
section: Data
order: 415
description: Decide whether an application needs compact public IDs and keep one identity consistent across its public surfaces.
tags: [data, identifiers, resources, capabilities]
updated: 2026-08-11
---

# Public resource identifiers

Short public IDs are optional. An application may already have a stable domain
identifier that works well for callers, or its resources may never need to be
addressed outside the application.

When an application chooses short IDs, one immutable, app-owned ID becomes the
resource's canonical public identity. Use it consistently wherever people,
agents, or other applications refer to that resource.

## Choose a public identity deliberately

Compact IDs are useful when resources appear regularly in URLs, logs, support
messages, command output, or agent conversations. They are easier to recognize,
copy, and compare than storage-oriented identifiers.

The additional identity has a cost: the application must create it, preserve
it, and resolve it to its internal record. Do not add short IDs to records that
are only internal, ephemeral, or never independently addressable.

An existing compact domain identifier can already be the right public ID. When
an application needs a generated short ID, Cloud applications use
`crypto.common.readableId(6)` from `@k2b/stdlib` as the common convention.

## Keep storage identity private

Public identity and database identity serve different purposes. A database can
keep UUID primary and foreign keys for relationships while the application
exposes a compact ID at its boundary.

This separation keeps storage choices private and lets the public contract
remain stable when internal relationships or persistence change. A database key
must not become a public ID only because it is readily available in a model.

The application owns the mapping. Public inputs are resolved before internal
domain work, and public results are projected before they leave the
application. See [Services and Result](/en/docs/server/services-and-results)
for the service boundary and
[Migrations and transactions](/en/docs/data/migrations-and-transactions) for
schema evolution.

## Use one identity everywhere

If an application adopts short IDs for a resource, that ID is the resource's
only public identity:

- APIs, URLs, command output, and live events use it;
- Capability readers and `CloudResourceRef` producers use it;
- Universal Search returns it;
- browser state and current cross-application consumers carry it;
- documentation and examples call the field `id`, not `shortId`.

Publishing both the short ID and an internal UUID creates two contracts. It
also makes callers guess which value belongs in a URL, reader, or later request.
Avoid dual resolvers, compatibility fallbacks, and parallel `id` and `shortId`
fields unless a separately planned migration temporarily requires them.

The adjacent contracts are documented in
[App capabilities](/en/docs/platform/capabilities),
[Universal Search](/en/docs/platform/search), and
[Route conventions](/en/docs/reference/route-conventions).

## Distinguish resources from virtual views

A generated view does not need a durable resource ID merely because a client
renders it. For example, one stored recurring event can produce many calendar
occurrences without turning every occurrence into a stored resource.

Keep the stored resource's public ID and carry the occurrence, revision, or
other view context separately. A composite view key may help a client reconcile
rendered state, but it must not silently become a canonical resource ID or a
`CloudResourceRef.id`.

High-volume telemetry records can retain technical identifiers. Give
independently addressable resources stable public IDs.
