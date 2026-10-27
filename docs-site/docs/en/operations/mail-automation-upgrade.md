---
title: Upgrade Mail automation ordering and assignments
navTitle: Mail automation upgrade
section: Operations
order: 1195
description: Review existing Mail rules before upgrading to ordered effects, guarded assignments, and the automation log.
tags: [operations, upgrades, mail, workflows]
updated: 2026-10-27
---

# Upgrade Mail automation ordering and assignments

This upgrade changes existing Mail workflows and guided incoming automations:
a rule no longer replaces an existing assignment. Any assignee prevents the
assignment step, whether assigned by a person or another rule. Editing an
assignment by hand does not modify the rule. Review workflows that previously
relied on automatic reassignment before rolling out the new Mail image.
`assignConversation` with `user: null` now leaves existing assignees in place;
it no longer clears them. Remove an assignment by hand or undo the rule's
current assignment from the log.

## Review overlapping rules

Rules for the same received-message event use `priority` ascending, then
workflow UUID ascending for equal priorities. Mail fixes this order when it
accepts the message event; edits affect later events.

Assignment, placement (move, archive, trash, junk), and status each have one
winner: the first rule that actually claims that effect class. A lower rule
waits for upper decisions, including AI steps. An upper rule that ends without
claiming a class leaves it available to lower rules. Tags, comments, and
summaries can come from every rule.

This replaces the old folder-selection behavior based on the oldest incoming
automation. Give rules distinct priorities where their order matters rather
than relying on UUID order. Existing saved definitions use the same assignment
guard; recreating a rule is not necessary to receive the new behavior.

Waiting uses durable workflow dependencies and rechecks unresolved state every
30 seconds. Restarts preserve the wait. A failed or canceled upper run releases
classes it did not claim. After 24 hours from ingress, a lower rule may retire
an unresolved upper participant and take over. That upper rule can no longer
apply exclusive effects after takeover. A claim already made still wins.
Thirty seconds is the recheck interval; it is not the takeover deadline.

## Explain undo and retention

The automation log records effects, skipped steps, decision chains, and manual
assignment changes. It uses the existing 30-day activity window. It is an
operational view, not a permanent compliance archive. Calendar days use UTC;
mailboxes have no separate timezone setting. Opening a decision chain
uses recorded AI output and makes no new AI call; source quotes may be absent.
The daily AI count covers that rule across all its versions, restricted to
conversations the reader may see. New audit entries refresh the open reader
through the same live updates as conversation changes.

Undo needs write access to the whole mailbox. One click reverses the entry's still-current assignments, local tag additions/removals, folder moves/archive, status, read state, other flags, and keywords. Later personal changes remain untouched. Comments stay as records; summaries have separate version history and are not undone.

Entries expose `undo.kept: [{ kind, reason: "changed_by_person" | "gone" }]` and `undo.reverted`, the original effects actually reverted. A partial undo is `done`; `available` means at least one effect can still be reversed, and `none` means there are no reversible effects. Older snapshots may omit the arrays. If nothing can safely change, both Undo and Redo return HTTP 409 `mail.automation.undo_not_possible` with `{ code, reason, item }`, without applying changes. `undo.at` and `undo.by` retain known undo/manual assignment-change attribution; unknown values are `null`.

Provider changes use the existing durable command path. Undo is done when commands are accepted; provider failures appear in normal command outcomes. Redo by the same actor restores only the subset Undo reverted and preserves later personal changes. Provider effects can be redone after their Undo commands finish. While any original or latest provider command in the group is queued, executing, or ambiguous, Undo/Redo returns HTTP 409 with reason `provider_pending` and changes nothing. Before Undo or after Redo, the entry shows `not_possible` with that reason until commands finish; an accepted Undo stays `done` while its commands run. Clients should show a temporary waiting message and allow retry after refreshing.

Migration adds per-effect snapshots and class exclusions without rewriting existing audit rows. Historical effects without provenance cannot be safely undone. Exclusions are keyed by workflow, conversation, and effect class: assignment, tags, placement, status, flags, or keywords. They survive the log's 30-day retention. A later reply skips each excluded class with `undone_before`; redo removes only the markers for classes it restores. Audit expiry never resets this protection.

## Verify the upgraded behavior

Before rollout, identify overlapping enabled rules and rules that previously
reassigned conversations. Tell mailbox managers that they must now change
existing assignments by hand.

In a test mailbox after upgrading:

1. Confirm an assigned conversation keeps all its assignees when a matching
   rule runs; the log records `already_assigned`.
2. Match two rules against one new message. Let the upper rule assign a person
   and confirm the lower assignment is skipped. Repeat with an upper rule that
   assigns nobody and confirm the lower assignment may apply.
3. Undo a current rule assignment, then receive another reply in that
   conversation. Confirm the same rule records `undone_before`.
4. Change a rule assignment by hand, then attempt undo of the original entry.
   Confirm it is refused and the manual assignment remains.
5. Check that a reader restricted to assigned conversations sees only permitted
   log entries and cannot use the log to read other conversations.

Inspect the same entries through the installed CLI after updating its Mail
plugin:

```sh
cld mail automation log --mailbox Support --day 2026-10-27 --json
cld mail automation log show <entry-id> --mailbox Support --json
```

Search with `--q` (at most 200 characters); counts cover the selected day and
search across all filters. Preserve day, search, and filter when paging with
`--before`. Use `cld mail automation log undo <entry-id> --mailbox Support`
only when you intend to remove that current assignment and prevent the rule
from assigning the conversation again. The CLI has no redo command; use the
immediate redo in the interface.
