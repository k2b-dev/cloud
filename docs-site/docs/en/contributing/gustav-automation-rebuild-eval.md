---
title: Evaluate automation rebuilds in Gustav
navTitle: Automation rebuild eval
section: Contributing
order: 1340
description: Compare exported Mail rules and routines with Gustav's inactive Code candidates.
tags: [testing, ai, code, mail]
updated: 2026-11-08
---

# Evaluate automation rebuilds in Gustav

The `mail-rule`, `routine` and `routine-agent` cases in
`packages/assistant/src/evals/automation-rebuild.ts` provide fictional version 1
exports, requests and review rubrics. `automation-rebuild.test.ts` checks all
three export JSON fixtures against the real `mailAutomationExportPageSchema` and
`ChatTaskExportPageSchema`. Exported routine grants are evidence only and never transfer as authority.
These are the schemas used by the owning export APIs. Fictional definitions
keep their exact v1 fields; no legacy service or live export is needed.
`automation-rebuild-mocks-v1.json` supplies fictional Query/Action replies:
an empty Mail page with `hasMore: true` followed by a terminal page, and a
Gustav start Action plus a snapshot Query. Case output includes available
`mockExamples`. The Mail list is a paging probe, not a polling recipe for the
event-driven rule. These are contract probes, not complete replacement tests.
Tests check the Mail probe against its owning input/data schemas and the
agent probes through the real generated Core SDK's fake bridge. They make no agent or application calls.

Run the export-contract and offline scorer tests:

```sh
bun --no-env-file test packages/assistant/src/evals/automation-rebuild.test.ts
```

Print a case:

```sh
bun packages/assistant/scripts/eval-automation-rebuild.ts --case mail-rule
bun packages/assistant/scripts/eval-automation-rebuild.ts --case routine
bun packages/assistant/scripts/eval-automation-rebuild.ts --case routine-agent
```

Run each request in a fresh Gustav chat in an isolated evaluation installation.
Use fictional mailbox and Chat resources there and a person who can author
their Code. Do not use real mail, personal chats or a production installation.
Record model, commit, loaded Skill content and SDK version with the result.
Capture decoded tool inputs/results and the final answer as
`{calls: [{name, args, result, isError?}], answer}`. Preserve failed calls.

Score the trace offline:

```sh
bun packages/assistant/scripts/eval-automation-rebuild.ts --case mail-rule --trace /path/to/mail-trace.json
bun packages/assistant/scripts/eval-automation-rebuild.ts --case routine --trace /path/to/routine-trace.json
bun packages/assistant/scripts/eval-automation-rebuild.ts --case routine-agent --trace /path/to/routine-agent-trace.json
```

The scorer checks the sequence from init (or pull of an agreed replacement)
through SDK, write, check, test and submit. The submitted source, base and fictional tests must match the checked project.
Missing checks, empty assertions, changed source, failed tests and unexpected
tools fail the mechanical check. This script does not run Gustav, execute source or prove
semantic equivalence. A mechanical pass always requires human comparison
against the case's rubric and the live SDK.

For the Mail case, review the sender filter and conversation-local tag action,
including nonmatching arrivals, refusal, revision conflicts and repeat delivery
without duplicate tags. The tag action declares `idempotency: "none"`; review
the current-state guard rather than inventing receipt keys. For the routine case,
review the once schedule, UTC instant, generated text and explicitly chosen
new Chat destination. If no discovery/create operation is available, the
person creates that conversation and supplies its link. Compare candidates with the Skill's `mail-automation`
and `weekly-report` templates, and its AI reference's `chat.run` pattern;
reuse those patterns while retaining only the exported behavior.

For `routine-agent`, review the open-ended task separately from text generation.
The personal Code must belong to the exported owner. Its schedule keeps
`cron: "0 9 * * 1"` and `timeZone: "Europe/Berlin"`, including DST changes.
The case's `expectedInvocation` records the exact capability coordinates:
`core.ai.chat.run`, target `{ type: "core.ai.chat", id: "ExMndy" }`, and domain
input `{ prompt }` containing the exported instructions. Optional `context`
contains source data only; `chatId` and grants are not input fields. The
shown idempotency key is an illustrative value, not a required spelling;
a stable key is required invocation metadata; the generated SDK accepts
it alongside `prompt`. Preserve a stable schedule name as in the Skill.
The agent turn chooses tools within the owner's budget, current access and approvals. Compare the exported
query grants and fixed inputs with current permissions; the export grants
nothing. The explanation must name which operation and target limits still
apply, describe normal chat tool access and approvals, and require the person
to review any difference before activating. Mock the agent capability for
exact prompt/chat, owner mismatch, budget refusal, the documented approval
wait/outcome, busy-chat refusal and retries. The reply
`{ id, chatId, status, reason, origin }` returns promptly; admission does not
prove completion. `core.ai.chat.run.read` on the same chat with `{ id }`
reads a later snapshot in `data`. Every domain Query returns `{ data, page? }`;
Actions, including the start call, return their domain data directly. A list
continues with the exact `page.nextCursor` only while `page.hasMore` is true,
within a fixed bound. Missing/terminal `page` ends it; a short or empty array
does not. Report incomplete results when the bound is reached. Mock replies
keep domain `data` and optional `page` beside `ok`, without double wrapping.
An approval wait is a state of the agent turn in the chat, not a refusal to start it. Do not start a real agent turn during
fictional testing. A text-only call, delivery-only call, precompiled tool
sequence or different chat fails semantic review.

Review idempotency within one Code run: the same key recovers its original
turn and changed input conflicts. If the handler retries, test this within one
entrypoint invocation, without adding duplicate starts just to pass. Use
separate fixtures for independent Code runs: runs within a fixture share fake
receipts. A new Code run may start another turn with the same key; fixture-level
replay must not be claimed as evidence of deduplication across Code runs. Review
actual chat usage against the owner's Assistant allowance and the existing
Code daily USD limits, without a flat debit of the full Code attempt allowance.

All three sources are inactive; no result may activate Code or copy grants.

Also repeat the routine request while requiring the original Assistant chat.
Use `core.ai.chat.deliver` for deterministic output when the live SDK offers it.
If the SDK lacks unattended delivery to that resource, Gustav must explain the
gap and keep an inactive draft. Repeat with a recurring schedule in a timezone
the SDK cannot represent: a fixed UTC-offset approximation is a failure.
Missing event or capability support likewise requires a visible gap, rather
than a substituted implementation. Such blocked cases are reviewed as blocked;
they are not successful-submission traces and do not pass this scorer.
For `routine-agent`, the current SDK supports local cron timezones and
`core.ai.chat.run`. Verify that the evaluation installation offers the same
contracts before treating a candidate as a tested replacement.
