---
title: Code in words
navTitle: Code in words
section: Platform services
order: 972
description: Read authorized version facts, example results and confirmed automation activity in the request language.
tags: [code, versions, runs]
updated: 2026-11-14
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
  matching behavior.
- `examples` contains saved names, results and observation sentences. Success
  means an example met its author's expectation; Cloud does not establish
  that the expectation is correct. A failed assertion may include up to four
  bounded expected/actual pairs. The display exposes scalar facts and value
  types, without raw structured payloads.
- `notices` contains a sentence and consequence for each checker finding.
  Technical codes and source coordinates remain available to CLI clients.

An unavailable target reader produces a generic type label and no link.
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

Run settlement saves its effect snapshot and updates one automation/week row
in the same transaction. Repeating settlement cannot increment it again. A late authoritative call
result updates the original run snapshot and the same weekly row atomically.
`recent` returns at most six confirmed results, with target links only when the
caller's current reader supplies an open link. `timeline` combines the local
day's recorded runs with future schedule slots. It has at most 200 marks;
large days are grouped with counts. Local day boundaries and planned slots
respect time zones and daylight saving changes.

The activity snapshot uses one SQL statement after Code authorization. The
integration SQL meter pins that statement and the complete loader's three
statements for a personal Code without provider targets. Canonical target
readers retain their own authorization and statement costs.

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
