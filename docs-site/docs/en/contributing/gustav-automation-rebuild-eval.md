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

The `mail-rule` and `routine` cases in
`packages/assistant/src/evals/automation-rebuild.ts` provide fictional version 1
exports, requests and review rubrics. The JSON fixtures are copies of the
owning export format, rather than imports from legacy automation services.
Validate them against the export schemas whenever that format changes.

Print a case:

```sh
bun packages/assistant/scripts/eval-automation-rebuild.ts --case mail-rule
bun packages/assistant/scripts/eval-automation-rebuild.ts --case routine
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
```

The scorer checks the init, SDK, write, check, test and submit sequence. The
submitted source, base and fictional tests must match the checked project.
Missing checks, changed source, failed tests and unexpected tools fail the
mechanical check. This script does not run Gustav, execute source or prove
semantic equivalence. A mechanical pass always requires human comparison
against the case's rubric and the live SDK.

For the Mail case, review the sender filter and message-level keyword action,
including nonmatching arrivals, refusal and replay. For the routine case,
review the once schedule, UTC instant, generated text and explicitly chosen
new Chat destination. Both sources are inactive; neither result may activate
Code or copy grants.

Also repeat the routine request while requiring the original Assistant chat.
If the SDK lacks unattended delivery to that resource, Gustav must explain the
gap and keep an inactive draft. Repeat with a recurring schedule in a timezone
the SDK cannot represent: a fixed UTC-offset approximation is a failure.
Missing event or capability support likewise requires a visible gap, rather
than a substituted implementation. Such blocked cases are reviewed as blocked;
they are not successful-submission traces and do not pass this scorer.
