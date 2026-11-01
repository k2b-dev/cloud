---
title: Upgrade Grids and Files capability callers
navTitle: Grids and Files targets
order: 421
updated: 2026-11-01
description: Send explicit base, table, and storage-root targets to Grids and Files.
section: Operations
tags: [capabilities, grids, files, upgrades]
---

# Upgrade Grids and Files capability callers

Follow the coordinated upgrade in [Capability targets](/en/docs/operations/capability-targets),
then refresh callers' cached catalogs when upgrading Grids and Files.

- Grids GQL and `view.create` use a `grids.base` target. Record writes and
  `document.create` use `grids.table`; `workflow.record-action` uses `grids.base`.
- Files browsing and organization use a storage-root `filesv2.entry` target.
  Discover it in `bases.list` as `data.items[].ref`. A folder below the root
  cannot replace it (`root_target_required`); put its relative path in input. Copying also requires a destination root in `refs.targetRootId`.

Send `target` and `refs` beside `input` over HTTP or the SDK. Remove the former
container `baseId` or `tableId` from the affected operation's input, and replace
Files copy's `targetBaseId` with the destination ref. Chat and MCP remain flat:
use `base`, `table`, or `entry` for the main target and `targetRootId` for a copy.
Keep contained record, template, launcher, source table, View, field, and path
values in input. Each app checks their containment as well as current permissions.

Canonical readers, global discovery, and shared file-provider calls retain their
input contracts. Files marks `provider.save` as `code: false`; ordinary file
chooser saves continue to work, and explicit uploads use `content.create` with a
root target. Mandate-backed background streams remain unavailable. Grids Custom
Apps, workflows, and the regular app-specific CLI retain their existing contracts.

Core migrates stored routine mandates and pending approvals at startup.
Literal Files base IDs become root entry refs; copy destinations remain fixed.
Unresolvable targets need confirmation before background work can resume.
Follow the [operator migration note](/en/docs/reference/deprecations-and-migrations#existing-assistant-routines-and-approvals-adopt-capability-targets).
