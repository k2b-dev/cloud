---
title: Administration › Code
navTitle: Code administration
section: Operations
order: 1256
description: Approve Code versions, edit the Code policy, see all Code, waiting cleanup, limits and runner capacity.
tags: [operations, code, policy, approvals, administration]
updated: 2026-11-01
---

# Administration › Code

Cloud administrators manage everything that runs as Code under
**Administration › Code** (`/admin/code`). The page uses the same column
pattern as the AI area: sections on the left, a list, and the selected item.
Every selection is part of the URL, so reload, back and shared links return to
the same place. Other people see a no-permission state; the page has no
partial view for them.

| Section | What it shows | Source of truth |
| --- | --- | --- |
| Approvals | Versions that wait for a Cloud administrator, and recently decided versions | [Code versions](/en/docs/platform/code-versions) |
| Code in this Cloud | Every Code with owner, status and last run | [Code data model](/en/docs/platform/code-data-model) |
| Policies › Default, Groups, Effective for … | The policy table, group rules, and the resolved table for one person | [Code policy](/en/docs/platform/code-policy) |
| Operations › Cleanup | Cleanup jobs that wait for a target app | [Code lifecycle](/en/docs/platform/code-lifecycle) |
| Operations › Limits | Registered Code execution and storage settings | [Code policy operations](/en/docs/operations/code-policy) |
| Operations › Runners | Instances, free slots, queue length, longest wait | [Code runner](/en/docs/operations/code-runner) |

## Approve or reject a version

A version lands under **Approvals** when one of its classifications resolves
to **Admin approval** for its author or owner. The review shows:

- why the version needs you: each classification and the default or group rule
  that decided it;
- what changes in permissions: each operation and exact target, marked new,
  unchanged or removed against the compared version, with its source line;
  choosing the line opens it in the Code difference;
- the complete Code difference against the last approved or switched-on
  version, or the whole Code for a first version.

The decision is bound to the exact version, source hash, bundle hash and
comparison shown in the footer. Cloud rechecks all of them when you decide. A
newer submission, a moved comparison or a Code difference that could not be
loaded disables **Approve** and names the reason. Rejecting asks for
confirmation. A decision cannot be withdrawn; the author submits a new version.

Authors do not approve their own versions. The one exception is an
installation with exactly one active Cloud administrator: the review then
shows that you are approving your own Code, and the version list labels the
result "self-approved (only admin)".

## Edit the policy

**Default** lists every classification with the number of Code that uses it
and its value: Automatic, Admin approval or Never. A preset replaces the whole
table, including group rules. **Groups** edits one group's rules; a row set to
"As default" has no group rule. **Effective for …** resolves the table for one
person and names the rule that decided each row.

Before saving, Cloud previews which running Code the change would pause. When
it would pause Code, saving asks for confirmation and lists it. Saving is bound
to the policy revision you read. If another administrator saved first, the
change stays on the page and **Check my change again** applies it on top of
the newer policy and previews it again. A failed save changes nothing and keeps
the change for **Save again**.

## Browser routes

The page calls Core routes under `/api/code/admin`. They require the Cloud
administrator role and use the same services as the `core.code.*`
capabilities and `cld code`:

| Route | Purpose |
| --- | --- |
| `POST /api/code/admin/decide` | `{ binding, approved }`; `binding` is the unchanged `CodeVersionBinding` |
| `POST /api/code/admin/policy/read` | The current policy with its revision |
| `POST /api/code/admin/policy/preview` | Paused Code for a complete replacement table, with owner names |
| `POST /api/code/admin/policy/update` | Replace the table at the read revision |

A stale revision, hash or comparison returns `409`.

## Runner section

The runner section shows the `CodeRunnerMetrics` read model: live instances,
their reported free slots, queued and running attempts, and the oldest waiting
time. When the queue grows and the waiting time rises, add runner instances.
Automatic scaling is not part of Phase 1.
