---
title: Files history reader checks
navTitle: Files history reader checks
section: Contributing
order: 1603
description: Verify bounded history counts, movement chains and access aggregates.
tags: [contributing, testing]
updated: 2026-10-25
---

# Files history reader checks

## A filtered page masquerades as batch context

- **Class:** A filtered page masquerades as batch context.
- **What goes wrong:** A search hides visible peers and a page count is displayed as the whole batch, or a raw total discloses hidden peers.
- **Guard:** Tests: Files `service/activity-batch.test.ts` and `service/activity-reader.integration.test.ts` anchor counts on a freshly projected event, apply the same local Cloud grant scope to peers, and mark the 500-candidate bound as a lower bound.
- **Evidence:** The focused tests named above.

## An ancestor's identity becomes its child's identity

- **Class:** An ancestor's identity becomes its child's identity.
- **What goes wrong:** An old descendant address follows the moved folder's stable ID and opens or offers actions for the folder instead of the child.
- **Guard:** Tests: Files `service/activity-reader.test.ts` scopes old paths to the visible before-side, keeps descendant chains probable and path-only, checks the current leaf, and stops at lifetime barriers and truncation. `activity-transports.test.ts` rejects unsafe old paths. UI `history-requests.test.ts`, `history.behavior.test.tsx` and `history-workspace.behavior.test.tsx` cover ancestor matching, the opened subject, and matching SSR/client requests without an automatic redirect.
- **Evidence:** The focused tests named above.

## Aggregate pagination loses its ordering evidence

- **Class:** Aggregate pagination loses its ordering evidence.
- **What goes wrong:** A network list sorts by its key instead of usage, or a period summary treats expired network identities as a complete count.
- **Guard:** Tests: Files `service/activity-reader.integration.test.ts` covers combined-usage order and ties, fresh cursor aggregates, cursor expiry, bounded UTC timelines, totals before and after rollup, and page-view-only networks per bucket. `activity-transports.test.ts` requires nullable bucket `pageNetworks` and rejects private share fields and visitor details.
- **Evidence:** The focused tests named above.

## Local archive snapshots lose their location

- **Class:** A current home prefix is applied to historical archive locations.
- **What goes wrong:** An administrator's local archive event disappears because its recorded path lies outside the binding's former home.
- **Guard:** Files `service/activity-reader.test.ts` and `service/activity-reader.integration.test.ts` preserve administrator snapshots for archived local bindings while ordinary readers require a current active grant.
- **Evidence:** The focused tests named above.
