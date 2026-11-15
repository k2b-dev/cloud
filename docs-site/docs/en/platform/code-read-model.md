---
title: Code in words
navTitle: Code in words
section: Platform services
order: 972
description: Read authorized version facts, example results and confirmed automation activity in the request language.
tags: [code, versions, runs]
updated: 2026-11-15
---

# Code in words

Use `core.code.version.words`, `core.code.run.words` and
`core.code.activity.words` to present Code without reconstructing sentences from
identifiers or source locations. Core returns the final text in the request
language. Chat, Code pages, pending requests and administration can share these
answers. Navigation keys identify records; they are not display labels.

## Read a version

`code.version.words` accepts `codeId`, `versionId` and an optional
`comparisonVersionId`. Omit the comparison to use the submission's saved
baseline; pass null for a first-version comparison. Both versions must belong
to this Code. Ordinary Code read permission suffices.

`CodeVersionReadModelSchema` from `@k2b/cloud/contracts` describes the answer:

- `description` contains the saved model explanation and its ✦ label. A missing
  explanation leaves the section absent. Core attempts generation after
  committing a submission, within the remaining submission budget. An AI
  failure does not undo the submission.
- `mayDo` contains checked operation titles and authorized target names and
  open links. It contains no model explanation or model-generated titles.
- `timing` describes schedules, manual runs, pages and event triggers.
- `changes` compares permissions, triggers, internet destinations, credential
  bindings, pages and database use. Rows contain `kind`, `text` and optional
  `note`. The `access_same_behavior_changed` state means the checked access
  facts match while the executable bundle differs. Matching facts never prove
  matching behavior. Added accesses that require an admin decision carry
  `requiresApproval`, `approvalReason` and `accessLabel`. `changes.approval`
  contains the full trigger count, a reason and `withoutLabel`: one access is
  named directly; multiple triggers use “Build without approval”. These facts
  use the effective policy for the owner or version author, including live
  group membership, in the existing version read statement.
- `examples` contains saved names, results and observation sentences. Success
  means an example met its author's expectation; Cloud does not establish
  that the expectation is correct. A failed assertion may include up to four
  bounded expected/actual pairs. The display exposes scalar facts and value
  types, without raw structured payloads.
- `notices` contains a sentence and consequence for each checker finding.
  Technical codes and source coordinates remain available to CLI clients.
  An archived or deleted bound chat adds a blocking notice with
  `code: "chat_missing"` and localized instructions to choose another chat or
  restore the archived chat. This notice reflects the current binding.

An unavailable target reader produces a neutral type label and no link;
a reader's explicit refusal may say that the target is not visible. Within one
read-model load, the owner reader answer also supplies that same target's
name and link, without another child Query. It is never reused across loads
or identities. Multiple other targets remain subject to the platform's
one-child-Query limit (tracked in #3423).

An unresolved static `mayDo.items[]` target carries an optional
`target: { ref: { type, id }, text }`. Its text has exactly one `{name}` slot;
the ordinary row text remains the neutral fallback. Targets Core has explicitly marked hidden, and ordinary dynamic
targets, do not carry this lookup hint. An unavailable invocation reader can
still carry the hint; the independent reader must authorize it again. At the outer request boundary, call
`nameCodeGrantTargets(model, invoke, readerOf, signal)` from `@k2b/cloud/code` to fill
these names independently of Core's consumed child Query. `invoke` must issue
independent canonical reader calls with the current viewer's credentials;
`readerOf` resolves each type's reader from that viewer's authorized catalog.
The helper reads at most 50 distinct targets, with at most eight providers in
flight, and deduplicates exact references. Only successful reader titles and
`open` links enter the row. Refusals, unavailable readers and malformed name
slots retain the fallback without a link. Render the resulting `text` as plain
text; never render the reference ID. This composition changes only grant rows;
it cannot unhide descriptions, examples, or comparison text. Pass the request
signal to cancel pending readers and prevent further batches.

For personal Code, a dynamic `core.ai.chat.send` permission uses the current
chat binding as a naming hint when that chat is active. Core returns:

```ts
{
  text: "Write to a chat, Gustav answers",
  note: "AI · with your rights, counts toward your allowance",
  target: {
    ref: { type: "core.ai.chat", id: "Chat23" },
    text: "Write to the chat “{name}”, Gustav answers"
  }
}
```

The existing `nameCodeGrantTargets` helper resolves this hint through the
catalog's `core.ai.chat` reader, `ai.chat.read`. Its authorized `data.view`
contains the title and permission. Only the chat owner receives the title;
other Code readers keep the neutral sentence. No binding, an archived chat,
or a deleted chat leaves out `target`. Changing the binding updates this hint
without changing version permissions, comparisons, or admin approvals.

Descriptions and example text are visible only when the caller can read every
version target. Otherwise the answer explains that the description names
unreadable targets. Administrator status alone does not authorize these names.
Facts remain separate from the ✦ explanation and example names.

Every ordinary list is limited to 50 rows with `more` and `moreText` for the
remainder. Examples follow the installation's `CodeTestLimits.cases`.

## Read a run and its effects

`code.run.words` accepts `codeId` and `runId`. It returns a localized status,
a title derived from confirmed observations, a failure reason when needed,
and `untilThen` for what happened before completion. Replayed calls, refusals
and unknown outcomes remain distinct for editors. Readers see confirmed
effects, without per-operation refusal or uncertainty counts. An incomplete history uses its trigger
and time as the title; it never claims nothing happened.

`code.activity.words` accepts `codeId`, an ISO `day` and an IANA `timeZone`.
Its weekly counters count confirmed successful Action invocations, grouped by
`automationKey` and operation. These are observed invocations, not inferred
numbers of items changed or estimated time saved. Replays, Queries and unknown
outcomes add no effect. UTC Monday boundaries define the durable week.
Each counter's `text` uses the persisted provider `countText` (for example,
“Tasks created”), with `count` displayed separately. Missing wording uses the
explicit “Action · n times” fallback.

Run settlement saves its effect snapshot and updates one automation/week row
in the same transaction. Repeating settlement cannot increment it again. A late authoritative call
result updates the original run snapshot and the same weekly row atomically.
`recent` returns at most six confirmed results, each with `text`, `at`,
`runId`, and optional `app` and `icon`. Its `text` names the resource kind without
a title or link. When evidence identifies exactly one result target, an optional
`target: { ref: { type, id }, text }` carries its reference and a localized named
sentence with exactly one `{name}` slot, for example `Aufgabe „{name}“ angelegt`.
Result references use opaque IDs; they must not encode names or paths.
A reference is a lookup key, not permission or display text. The Code page resolves
each target through a separate canonical reader with the person's authority,
at most six calls. Only a successful reader's title replaces `{name}` (as plain
text, never as a template), and only its `open` link becomes a link. On denial,
missing reader or failure, retain the original kind-only `text` without a link;
never show an identifier. Core spends no child Query resolving recent results.

Result forms are provider-owned, translated presentation snapshots. Missing or
ambiguous evidence uses “Action · n times” with no `target`. Run `untilThen.items`
still resolves names through its current resource readers; its `state` distinguishes
successful effects, replayed calls, refusals and unknown outcomes. `timeline` combines the local
day's recorded runs with future schedule slots. It has at most 200 marks;
large days are grouped with counts. Local day boundaries and planned slots
respect time zones and daylight saving changes.

The activity snapshot uses one SQL statement after Code authorization. The
integration SQL meter pins that statement and the complete loader's three
statements for a personal Code without provider targets. Canonical target
readers retain their own authorization and statement costs.

## Activation and pause dates

`core.code.read` and `core.code.list` include nullable `activatedAt`,
`activatedBy: { name }` and `pausedAt`. Activation attribution comes from the
current version's most recent successful `code.activations` receipt, projected
in that transaction. Failed attempts do not change it. The name follows the
person directory's visibility rules; a missing or unreadable name is null and
never replaced by an identifier. Pause transitions record `pausedAt` for every
pause cause; other updates preserve it, and resuming clears it. Older pauses
without a recorded timestamp remain null. Read/list use their existing SQL
statements for these fields.

## Read the Code tab

`core.code.source.tab` requires editor rights, including for Cloud
administrators. It returns the enabled version's metadata and source, a source
difference against any `comparisonVersionId` of this automation, and up to
50 versions with their number and submission date. Pausing keeps the enabled
version selected; a pending submission never replaces it. No enabled version
means no source. `sourceOffset`, `diffOffset` and `before` page these three
independent parts; text chunks are limited to 16,384 UTF-16 units.

Dynamic targets cannot establish that every possible target is readable.
Their free description and example text therefore remain restricted for all
readers; checked facts still describe the target type.

The consumer fixtures live in Core's `code/read-model/fixtures.ts`:
`codeReadModelFixture`, `codeRunReadModelFixture` and
`codeActivityReadModelFixture` each accept `de` or `en` and return a fixed,
fictional snapshot. Render tests can use these answers directly with the
shared view blocks; the read model adds no block schemas.

The `code-no-source` repository rule renders the Code surfaces and rejects
new technical text outside the two explicitly marked source fields. Its
`scripts/checks/code-no-source.baseline` records existing findings by rendering
file, exact finding and count. Removed findings must lower or remove their
entry; `bun scripts/check.ts code-no-source --fix` only makes those reductions.
The version card/chat, Code page and administration migrations must empty
this baseline before the v12 preview (issue #3357).

Automation metadata keeps `nextRunAt` authoritative to the registered scheduler.
`nextRunState` distinguishes `planned`, `none` (for example a paused automation)
and `unavailable`. A null date with `unavailable` must not be labelled “none
planned”. Hour-range minute schedules include the final hour: `* 7-20 * * *`
means every minute from 07:00 through 20:59 in the schedule's time zone.
