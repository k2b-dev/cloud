---
title: Evaluate automation rebuilds in Gustav
navTitle: Automation rebuild eval
section: Contributing
order: 1340
description: Compare exported Mail rules and routines with Gustav's inactive Code candidates.
tags: [testing, ai, code, mail]
updated: 2026-11-07
---

# Evaluate automation rebuilds in Gustav

The `mail-rule`, `routine` and `routine-agent` cases in
`packages/assistant/src/evals/automation-rebuild.ts` provide fictional version 1
exports, requests and review rubrics. The JSON fixtures are copies of the
owning export format, rather than imports from legacy automation services.
Validate them against the export schemas whenever that format changes.

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
new Chat destination.

For `routine-agent`, review the open-ended task separately from text generation.
The personal Code must belong to the exported owner. Its schedule keeps
`cron: "0 9 * * 1"` and `timeZone: "Europe/Berlin"`, including DST changes.
The case's `expectedInvocation` records the exact capability coordinates:
`core.ai.chat.run`, target `{ type: "core.ai.chat", id: "ExMndy" }`, and domain
input `{ prompt }` containing the exported instructions. Optional `context`
contains source data only; `chatId` and grants are not input fields. The
required idempotency key is invocation metadata; the generated SDK accepts
it alongside `prompt`. The schedule's stable name belongs in its third
argument. The agent turn chooses tools
within the owner's budget, current access and approvals. Compare the exported
query grants and fixed inputs with current permissions; the export grants
nothing. The explanation must name which operation and target limits still
apply, describe normal chat tool access and approvals, and require the person
to review any difference before activating. Mock the agent capability for
exact prompt/chat, owner mismatch, budget refusal, the documented approval
wait/outcome, busy-chat refusal and retries. The reply
`{ id, chatId, status, reason, origin }` returns promptly; admission does not
prove completion. `core.ai.chat.run.read` on the same chat with `{ id }`
reads a later snapshot. An approval wait is a state of the agent turn in the
chat, not a refusal to start it. Do not start a real agent turn during
fictional testing. A text-only call, delivery-only call, precompiled tool
sequence or different chat fails semantic review.

Review idempotency within one Code run: the same key recovers its original
turn and changed input conflicts. A new Code run may start another turn with
the same key; the evaluation must not claim deduplication across runs. Review
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
This also applies to `routine-agent` until the evaluation installation offers
both local cron timezones and `core.ai.chat.run`. The chat capability is
available on `feat/code` from #2838; cron timezone support remains conditional
on the installed SDK. Discover the actual API and verify its presence in the
evaluation installation before treating it as a tested replacement.
