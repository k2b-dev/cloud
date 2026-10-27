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

Undo needs the same permission as manual assignment. It reverses the rule's
assignment only while that assignment is still current; it does not reverse
other effects, such as moves, tags, or comments. If someone changed the
assignment or the conversation is gone, the request returns HTTP 409 with
`mail.automation.undo_not_possible` and changes nothing.

Undo creates a permanent exclusion for that workflow and conversation,
including later incoming replies. The exclusion survives expiry of the log
entry. Only redo immediately after undo by the same person restores the
assignment and removes that exclusion. Do not treat audit retention as a way
to reset the assignment guard.

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
