---
title: Code policy
navTitle: Code policy
section: Platform services
order: 961
description: Set classification rules for Code, preview affected versions and understand policy pauses.
tags: [code, administration, policy, permissions]
updated: 2026-10-31
---

# Code policy

Cloud administrators control whether Code classifications run automatically,
need a Cloud administrator's version approval, or never run. A policy never
grants access to an application or resource. Activation and every capability
call must still satisfy their own access checks.

## Choose a table

The values are `automatic` (**Automatisch**), `admin` (**Admin gibt frei**) and
`never` (**Nie**). Core starts with the **Admin** preset:

| Classification | Row | Admin preset |
| --- | --- | --- |
| Queries | `read` | Automatic |
| Silent Actions for the person | `silent_you` | Automatic |
| Silent draft Actions | `silent_draft` | Automatic |
| Silent Actions visible to others | `silent_shared` | Admin approval |
| Sends | `ask_sends` | Admin approval |
| Deletes | `ask_deletes` | Admin approval |
| Cannot undo | `ask_cannot_undo` | Admin approval |
| Involves people | `ask_involves_people` | Admin approval |
| Changes access | `ask_changes_access` | Admin approval |
| Keeps working | `ask_keeps_working` | Admin approval |
| Sensitive | `ask_sensitive` | Admin approval |
| App asks | `ask_app_asks` | Admin approval |
| AI use | `ai` | Admin approval |
| External requests and public endpoints | `internet` | Admin approval |

**Off** (`off`, **Aus**) sets every row to `never`. **Open** (`open`, **Offen**)
sets every row to `automatic`. Applying a preset replaces group overrides too.
Editing individual rows produces a `custom` table.

The classification follows the declared Action policy; an Action without one
uses `ask_app_asks`. Separate execution restrictions still apply. In particular,
the Open preset does not enable unattended sending in Phase 1 or allow an
Action that declares `code: false`.

## Resolve groups

Personal Code uses its owner's current memberships, including local parent
groups. For each row, Core applies these rules in order:

1. A default of `never` vetoes every group override.
2. Any applicable group value of `never` vetoes all other rules.
3. A subgroup's explicit rule replaces its ancestor's rule.
4. Unrelated groups, groups in a cycle and groups from different providers are
   peers. The stricter value wins: `never`, then `admin`, then `automatic`.
5. Without a group rule, use the default.

Specificity follows ancestry, rather than the number of levels in a tree.
Ancestry stays inside one identity provider. FreeIPA effective memberships are
resolved by name against current group UUIDs. Since Cloud does not store their
hierarchy, FreeIPA groups are peers. They have the same policy rank as local
groups.

Resource and application Code use the default rows. Their version author's
applicable `never` rules also veto execution. Other author group overrides do
not replace the default. A group's automatic rule therefore cannot loosen the
installation policy for shared resource Code.

## Read, preview and save

These capabilities use the standard Core capability transport:

| Capability | Who | Input and result |
| --- | --- | --- |
| `core.code.policy.read` | People | `{}` returns `{ policy }`; ordinary people receive defaults and their applicable group rules, Cloud administrators receive the whole table |
| `core.code.policy.effective` | People; administrators for other views | Optional `owner` and resource/app `authorId`; returns `{ revision, rows }` with each resolved value, source and group UUIDs |
| `core.code.policy.preview` | Cloud administrators | `revision`, complete `definition`, optional `cursor`, `limit`; returns the exact `total` pause count, an `items` page and `nextCursor` |
| `core.code.policy.update` | Cloud administration authority | `revision` and complete `definition`; returns `{ policy, pauseJobId }` |

A policy contains `revision`, `definition`, `updatedBy` and `updatedAt`.
A definition contains `preset` and `rules`; each rule is
`{ groupId: string | null, row, value }`. A null group is the default. Supply
exactly one default for every row. Omit a group row to inherit; duplicate rules
and unknown groups are rejected. The complete table accepts at most 200 rules
so it fits the capability input budget.

Read the latest revision, preview the complete proposed table, then update
with that revision. A stale preview or save returns `CONFLICT`; reread and
review the draft against the new table. A failed save leaves both the policy
and pause queue unchanged. Phone sessions and credentials without full Cloud
administration authority cannot update policy. The update Action requires
review and cannot be called by Code.

Preview checks active versions against their used rows and existing approval
coverage. It counts only rows that become stricter and either become `never`
or require an approval the version lacks. A looser table pauses nothing.
`total` covers all active candidates in one database snapshot; `items` checks
at most `limit` candidates (default 20, maximum 50). An empty page can still
have `nextCursor`. Follow it until null.

## Recognize a policy pause

Saving atomically commits the new table, its revision and a durable pause
job. Core scans at most 50 active versions per transaction. It records
`state: "paused"`, `pauseReason: "policy_changed"`, `pauseRows` and
`pausePolicyRevision` on affected Code. The existing Code read and list Queries
include those fields. A used row of `never` pauses even an approved version;
a newly required admin approval preserves versions already covered for that row.

The worker rereads the current policy, active version and approval coverage.
If a newer policy or version permits the Code, a pending older job does not
pause it. A failed batch remains in the outbox with retry information and
retries with backoff. Relaxing a table does not resume paused Code. Activation
and resume must recheck the current policy and approval.

The pause worker makes the restriction visible. The dispatcher must enforce
the current policy on every call, including before the worker reaches a Code.
An already accepted effect can finish; later calls need a fresh check.

## Maintainer contracts

Core modules import the policy exports from `packages/core/src/code/index.ts`.
Other applications use the capabilities rather than Core imports or tables.

- `CodePolicyRow`, `CodePolicyValue`, `CodePolicyRule`, `CodePolicyDefinition`
  and `CodePolicy` define the shared policy vocabulary.
- `CODE_POLICY_ROWS`, `codePolicyPreset`, `codePolicyRow` and
  `codePolicyContracts` provide classifications, presets and transport schemas.
- `effective(row, owner, definition, groups)` resolves one row, with
  `CodePolicyGroups` containing memberships and transitive ancestry. Use
  `readCodePolicyGroups` to read current memberships from Postgres, rather than
  a cached user object.
- `readCodePolicySnapshot(db)` reads authoritative policy without a cache.
  Dispatch and activation must read it, current groups and approval in the same
  transaction snapshot. When taking locks, lock `code.policy` before Code rows.
- Checked version manifests include `policyRows: CodePolicyRow[]`, validated by
  `CodePolicyManifestSchema`. The list covers every used classification,
  including AI and external requests. Missing or invalid rows are evaluated
  conservatively against all classifications during a tightening, with
  `pauseReason: "policy_rows_unavailable"` when paused.
- C8 writes `replaceCodePolicyCoverage(versionId, rows, tx)` in the same
  transaction as its verified Cloud-admin approval decision. The version ID
  binds coverage to immutable source, bundle and manifest. Lock the owning Code
  before changing active-version coverage; remove coverage on rejection or
  revocation. This storage helper supplies no approval or execution authority.
- `CODE_SETTINGS` and `codeSettings` register and read storage and execution
  budgets. The execution host enforces the runtime settings described in
  [Code operations](/en/docs/operations/code-policy).

Core owns `code.policy`, `code.policy_rules`, `code.policy_coverage` and
`code.policy_pause_outbox`. Policy updates record `core.code.policy.updated`
with the revision and pause job ID in the same transaction.
