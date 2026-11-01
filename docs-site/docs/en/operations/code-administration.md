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
partial view for them. The "Code" entry in the Administration sidebar shows the
number of open Code-version approvals for the signed-in Cloud administrator.

| Section | What it shows | Source of truth |
| --- | --- | --- |
| Approvals | Versions that wait for a Cloud administrator, and recently decided versions | [Code versions](/en/docs/platform/code-versions) |
| Code in this Cloud | Every Code with owner, status and last run | [Code data model](/en/docs/platform/code-data-model) |
| Policies › Default, Groups, Effective for …, History | The policy table, group rules, the resolved table for one person, and recent changes from the audit log | [Code policy](/en/docs/platform/code-policy) |
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
- the internet targets: each exact HTTPS origin the version may send a secret
  to, from its secret bindings, and whether calls without a secret reach public
  HTTPS addresses;
- what happens: a short AI explanation of the version, marked as only a hint.
  An open review asks for it once; it is stored per version and language and
  charged to the administrator who asked first. When no explanation can be
  generated the review says so and offers a retry; deciding never depends on it;
- the check Core ran at submission: types, the author's test fixtures, and a
  trial run with their test data that lists each call with its count, compared
  with the earlier version when that has a record. Fixtures run against fake
  data, so nothing real happens. Failed tests or tests that could not run are
  shown and do not refuse the version;
- the complete Code difference against the last approved or switched-on
  version, or the whole Code for a first version.

The decision is bound to the exact version, source hash, bundle hash and
comparison shown in the footer. Cloud rechecks all of them when you decide. A
newer submission, a moved comparison or a Code difference that could not be
loaded disables **Approve** and names the reason. Rejecting asks for
confirmation. A decision cannot be withdrawn. To take an approval back, pause
the Code: Cloud administrators can pause and resume any Code from its detail
under **Code in this Cloud**. Resuming checks the active version's approval
under the current policy again.

Authors do not approve their own versions. The one exception is an
installation with exactly one active Cloud administrator: the review then
shows that you are approving your own Code, and the version list labels the
result "self-approved (only admin)".

## Read a version's Code

Under **Code in this Cloud**, choose **View code** or a version in a Code's
detail to read that version's complete source, read-only, with or without an
open approval. The selection is part of the URL. Like the other reads in this
area it needs the Cloud administrator role and writes no audit entry.

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
the newer policy and previews it again. A refused save changes nothing and keeps
the change for **Save again**, which previews and confirms the current change
first. When the answer to a save or decision is lost, the page says so instead
of claiming that nothing changed.

**History** lists recent policy changes from the audit log: who saved, when,
and each changed row with its old and new value. Code keeps no history store
of its own.

## Browser routes

The page calls Core routes under `/api/code/admin`. They require the Cloud
administrator role and use the same services as the `core.code.*`
capabilities and `cld code`:

| Route | Purpose |
| --- | --- |
| `POST /api/code/admin/decide` | `{ binding, approved }`; `binding` is the unchanged `CodeVersionBinding` |
| `POST /api/code/admin/pause` | `{ codeId, paused }`; pause or resume any Code |
| `POST /api/code/admin/policy/read` | The current policy with its revision |
| `POST /api/code/admin/policy/preview` | Paused Code for a complete replacement table, with owner names |
| `POST /api/code/admin/policy/update` | Replace the table at the read revision |

A stale revision, hash or comparison returns `409`.

## Runner section

The runner section shows the `CodeRunnerMetrics` read model: live instances,
their reported free slots, queued and running attempts, and the oldest waiting
time. When the queue grows and the waiting time rises, add runner instances.
Automatic scaling is not part of Phase 1.
