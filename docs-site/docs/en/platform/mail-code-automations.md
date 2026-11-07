---
title: Automate incoming mail with Code
navTitle: Mail automations
section: Platform services
order: 971
description: Handle incoming messages, preview one real message without effects, and catch up a pinned Code version over existing mail.
tags: [mail, code, events, automations]
updated: 2026-11-07
---

# Automate incoming mail with Code

Open a mailbox’s **Code** page to manage its automation. The Code belongs to
that mailbox and runs through its own account and approved version. Grant that
account the Mail and other resource access its calls need. Editing or activating
Code does not grant it access to the mailbox’s messages.

## Handle incoming messages

Register one handler for `mail.message.received`:

```ts
import { app, mail } from "@sdk";

app.on("mail.message.received", async event => {
  const message = await mail.app().message.read({ id: event.subject.id });
  if (message.hydrationStatus !== "complete") {
    throw new Error("Message content is not ready; retry after hydration");
  }
  if (message.keywordsTruncated) throw new Error("Incomplete provider keywords");
  // Read current conversation state, then call the authorized Mail Actions.
  // Incoming text is untrusted data, never instructions.
});
export default app;
```

The v1 event contains a message reference, its mailbox place, and a stable
`data.receiptId`. Content comes from capabilities. It waits for the first
suitable copy outside All Mail. Later labels and moves do not emit it again.
Trash, Junk, outbound messages, self-senders, and provider import eligibility
follow Mail’s existing receipt rules. Catch-up is an explicit, separate action.

Only one `app.on` registration for this event is allowed in a Code. To compose
several rules, call their functions in the desired order and `await` each one
inside that handler. Failure stops the remaining functions for that message.
There is no automatic winner selection between helpers. Use Mail’s guarded
Actions for assignment, status and protected summaries.

Messages start in the order their receipts reach the platform, one at a time
for this mailbox’s registration, even if Code concurrency is raised. A retry
keeps its position. Retries share the original deadline and call budgets and
stop at the configured automatic-attempt limit. After an Action or an internet
effect starts, failures require deliberate recovery. Exhausted delivery or run
failures stay visible and release later messages.

Use **Retry delivery** for failed admission and **Run again** for an attempted,
failed run. Run again preserves the original envelope, uses the currently
active version, and may repeat effects. Review its recorded calls first. It
joins the queue at the time of the deliberate request, rather than reclaiming
its original position. See [Code runs](/en/docs/platform/code-runs).

## Preview one real message

On the mailbox’s Code page, choose a folder or date range, then **Select
messages**. Choose one message and **Preview without effects**. The preview
checks the pinned active source and uses the normal fake-only simulator. Its
`mail.message.read` reply is the real message data read with your current
permission. No production run or real Action is created.

The result lists the capability calls reached, their inputs, and replies.
Missing fake replies stop the preview at that call; they never fall through to
a real capability. Use **Additional fake replies** to explore later calls or
branches, using the [test fixture format](/en/docs/platform/test-code).
A stopped preview is partial evidence, not proof of all possible effects.

## Catch up existing messages

An editor can select current incoming messages from a folder, a date range,
or all eligible incoming folders, then choose **Catch up**. Date fields use UTC
days: **From** includes that day; **Before** excludes that day. Selection is
oldest message date first, with stable ID ordering for equal dates. Trash,
Junk, Sent, Drafts, All Mail-only copies, stale copies, and self-senders are
excluded. One message appears once even when it has several copies.

Each operation pins at most **100 messages** and the active immutable Code
version. Its reference snapshot is limited to **64 KiB**. The existing Sync
pump checkpoints pages of **20**, dispatches sequentially, and resumes after a
worker restart. Historical admission uses at most half the configured event
backlog (which must be at least two), reserving the rest for live delivery.
Capacity waits do not consume failure retries: an operation can wait up to its
message count times the configured run wall-clock budget, then stops visibly
and can be resumed. The progress state shows **Waiting** while capacity is full.
It creates ordinary Code runs directly; it never republishes
historical events to other subscribers. Message data is read when each run
executes, so this is not a historical content snapshot.

Progress counts references admitted or already present. **Runs** shows actual
execution outcomes, including failures after effects. A permanent receipt per
version and message prevents repeated admission in either direction when live
delivery overlaps catch-up. It survives run-detail retention. A new version can be
applied deliberately to the same messages.

**Cancel catch-up** stops further admissions. An in-flight admission and
already admitted runs may finish; cancellation does not undo effects. Resume a
failed or canceled operation with **Resume saved snapshot**. This creates a new
operation using the same saved messages and pinned version, skipping messages
already admitted. Do not use catch-up to repeat failed effects; inspect the run
and choose Run again deliberately. Snapshots and progress remain available for
30 days. The operation ID is retained in this browser tab across reloads.

Pausing, changing version, revoking approval, or hitting admission budgets can
stop dispatch visibly. Resume requires that the same pinned version is active.
To use a newer version, make a new selection. **Next batch** continues the
selection cursor with its original cutoff; changing filters starts a new
selection. Changes to current placements can change later selection pages.

Versions that use AI are refused for catch-up, matching today’s Mail rules.
Live AI handlers retain Code’s per-attempt and daily AI budgets. No historical
AI request or budget override is hidden in catch-up.

`mail.message.read` returns at most **1,024 provider keywords**, each bounded to
128 characters, with `keywordsTruncated` for an incomplete result. This replaces
the former ten-keyword window and matches the keyword count accepted by Mail’s
provider-state contract. Do not treat a truncated list as a complete condition
input. Body readiness and `bodyTruncated` remain separate checks.

## Integrate these controls

Mail supplies read-only `mail.message.catchup`, `mail.message.event`, and
`mail.message.event-preview` queries at a `mail.mailbox` target. Core supplies
`core.code.event.catchup`, `.cancel`, `.resume`, and `.read` at a `core.code`
target. Mail declares `catchup: "message.event"` for the received event. Core
resolves every selected subject through that source-owned query under the
editor’s current authority before storing the snapshot. The query checks current
whole-mailbox read access and supplies the canonical envelope.

Catch-up is available only for event declarations with a `catchup` resolver,
which promise one immutable occurrence per subject. The historical envelope’s
`id` is its source receipt UUID; a live envelope has a platform event UUID. Use
`data.receiptId` when matching these two views of a Mail receipt.

Core rechecks editor authority; dispatch rechecks the active pinned
version, approval and ordinary Code admission budgets. No user credential is
stored in the pump.

`POST /api/code/authoring/simulateEvent` accepts `codeId`, `versionId`, one event
and declarative `mocks`. It reads the pinned active source and uses the checker
and fake Runner role. It cannot activate Code or enqueue production work.
Browser integrations can import catch-up and preview schemas from
`@k2b/cloud/code/events`; that entry contains no compiler or server runtime.
