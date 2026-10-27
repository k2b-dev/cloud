---
title: Mail AI daily limits
section: Operations
order: 947
description: Understand Mail's calendar-day AI reservations, mailbox cap, and upgrade behavior.
tags: [mail, ai, limits, upgrades]
updated: 2026-10-27
---

# Mail AI daily limits

Mail's daily-budget service admits an operation only when its planned maximum
number of AI calls fits both the source's allowance and the mailbox allowance.
Callers reserve before changing mail. A denial returns `scope` (`rule` or
`mailbox`), `limit`, and the ISO `resetsAt` instant, without changing mail or
creating a reservation.

These are call counters, separate from Cloud's [central AI accounting](/en/docs/ai/usage-and-feedback).
The existing `WORKFLOW_AI_BUDGET` remains an independent operator control: its
2,000-source default counts distinct message sources over a rolling 24 hours,
not calls in a calendar day. Daily reservations do not replace that admission,
its concurrency limits, or the person's own AI allowance.

## Set the mailbox allowance

The mailbox administration service provides `getMailboxAiDailyLimit` and
`updateMailboxAiDailyLimit`, both requiring current mailbox admin permission.
The setting is `maxAiCallsPerDay`:

- `null` (the default) adds no mailbox daily cap.
- A positive integer caps admitted AI calls across sources in that mailbox.
- `0` pauses new operations that need AI calls. Operations planned with zero
  calls can still proceed.

A setting change uses the existing mailbox audit and live-update mechanisms.
Lowering a cap blocks new reservations. It preserves already admitted work
and completed usage; raising or removing the cap permits new work immediately.
This core exposes service methods; it adds no setting control, HTTP endpoint,
CLI option, or workflow-language field. Only callers using this reservation
service enforce the calendar-day cap.

## Know when the day resets

There is no mailbox-specific timezone setting. Mail uses the installation's
Core `app.timezone`, with `Europe/Berlin` as its fallback, as Mail reminders do.
Each new operation uses that timezone's calendar date and next local midnight.
A daylight-saving transition can make a day shorter or longer than 24 hours.
Changing the installation timezone applies to new operations; existing
reservations retain their recorded day and reset instant.

A pending reservation counts against admission immediately. The source stats
service reports completed successful calls as `aiCallsToday` and outstanding
holds as `reservedAiCalls`. `limitedUntil` is the next midnight when either
allowance has no capacity for another call, otherwise `null`. An operation
needing several calls can be denied before the allowance is fully used.
A failed operation's release can free capacity before midnight.

## Reserve and settle one operation

Mail service consumers use `reserveAiDailyBudget` with a stable `sourceId`,
`sourceName`, operation `reservationKey`, `plannedMaxCalls`, and optional source
`maxAiCallsPerDay` (a positive integer or `null` for no source cap). Keep the
same source ID across versions or renames to share
its counter. Sources do not reference workflow tables.

Concurrent reservations cannot oversubscribe either allowance. Repeating an
admitted key returns its existing reservation; changing its planned maximum
is a conflict. A successful operation calls `consumeAiDailyBudget` with its
actual successful call count, at most the reserved maximum, which also releases
unused capacity. Repeating that settlement is harmless. Failed or cancelled
operations call `releaseAiDailyBudget`; retries can reserve that released key
again. Releasing a completed reservation does not erase its successful calls.

Reserve, consume, and release accept the caller's transaction as `db` so the
reservation and pending work can commit or roll back together. Without `db`,
each method owns a short transaction. Callers lock the mailbox before a
conversation, unwrap failed results to roll back their transaction, and keep
network calls outside it. A durable pending-work owner must recover or release
its holds after a crash; this core does not run a recovery worker.

A reservation settled after midnight updates its original day's counters.
It does not consume or release the new day's allowance. A retry of a completed
key remains completed across midnight; a new operation needs a new key.

## Upgrade Mail

Startup adds the nullable mailbox `ai_calls_per_day` setting, mailbox and source
daily counter tables, and the idempotent reservation table in one transaction.
Existing mailboxes retain no extra daily cap and start with no usage history.
The addition is independent of summary provenance and pending-summary storage;
it follows Mail's idempotent baseline-additions migration contract and can
run again without clearing settings, reservations, or counters.

Counters and reservation keys are durable Postgres data and are deleted with
the mailbox. There is no automatic expiry or cleanup worker for this history:
removing a completed key would also remove its protection against duplicate
charges. Include this state in the existing Mail database backup policy.
