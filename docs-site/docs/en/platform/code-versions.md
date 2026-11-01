---
title: Code versions and approval
navTitle: Code versions
section: Platform services
order: 962
description: Submit checked Code, compare complete source versions and decide hash-bound Cloud-admin approvals.
tags: [code, approvals, versions]
updated: 2026-10-31
---

# Code versions and approval

Submit a checked source and bundle together. Core saves an immutable version
and requests a Cloud administrator's approval when the current
[Code policy](/en/docs/platform/code-policy) requires it. The previous active
version keeps running while the new version waits. Approval alone does not
activate a version or grant resource access.

## Submit a version

`core.code.version.submit` accepts `codeId`, `sourceFiles`, `bundle`,
`manifest` and `baseVersionId`. Use the latest saved version's UUID as the base,
or null for the first push. The caller needs Code editor access and a write
credential. Phone sessions cannot submit lasting Code authority.

The submission review names the Code and shows the exact proposed bundle,
manifest and complete source comparison. It explains that the active version
keeps running and older pending version requests are cancelled after a successful
submission. Reviews only read and validate; they save no version or decision.
If the complete submission review exceeds the platform content budget, it returns
`BAD_INPUT`; the review is never truncated.

The result contains `version`, `binding`, `status`, `approvalId` and `decision`.
`status: "submitted"` means the current policy needs no administrator's
approval. `status: "pending"` has a platform approval request. Neither status
changes the active version.

Core checks the source and bundle hashes, source locations, manifest
classifications against the current capability catalog, and current policy before committing. A forbidden row returns
`code_policy_never`. Unattended `ask_sends` is refused with
`code_sends_not_yet` in Phase 1, even under the Open preset. Sending without a
person is reserved for Phase 3.

If someone pushed first, submission returns `code_version_conflict` with
“Neuere Version vorhanden” in German, `details.latestVersionId` and the
complete `details.files` difference from the requested base to the latest
saved version. Review and reconcile those changes, then submit with that base.
The failed push saves neither a version nor an approval request. Conflict details
also contain `diffRead: { query, input }`. If the full rows exceed the transport
budget, the error retains its stable code, latest ID and this complete-diff
reader instead of embedding the rows.

### Checker manifest

`CodeCheckedVersionManifestSchema` and `CodeCheckedVersionManifest` are exported
from `@k2b/cloud/contracts` and re-exported by Core's `code/index.ts`. The host
copies these fields unchanged from the checker's `checkCode` result:

- `version: 1`;
- `entrypoints`: `{ kind: "schedule" | "manual", entrypoint, cron, file, line }`;
- `permissions`: `{ operation, target, file, line }`, retaining separate source
  rows for literal targets and references. An app-wide operation has a null
  target; dynamic personal targets have a null `target.id`;
- `ai`: whether detected calls use AI;
- `hashes`: lowercase SHA-256 digests for `source`, `sdk` and `bundle`.

The host adds `entry` from the original `CodeCheckRequest.entry` and
unique `policyRows` from operation metadata, including every used classification
and any AI or internet use. Core resolves each declared operation in the current
catalog and refuses missing classifications or operations unavailable to Code.
`code: false` actions remain available to personal Code acting with person
authority; resource-owned and app-owned Code cannot use them. Keep the checker's
permission rows and entrypoints unchanged; locations are one-based. Core validates
their source locations.

Source hashing matches the checker: SHA-256 over UTF-8
`JSON.stringify({ entry, files })`, where `files` contains sorted `[path, content]`
pairs. SDK hashing covers recursively key-sorted SDK JSON. Bundle hashing covers
the exact UTF-8 bundle. The manifest is saved at version creation and cannot be
replaced later. A manifest never grants permission to make a call. Dispatch
checks each actual operation against current policy, version approval, mandate
and resource access.

## Compare what will be approved

`core.code.version.diff({ codeId, versionId })` returns `binding`,
`staleComparison`, `files`, `permissions` and `policyRows`. It compares against
the last approved version or the last successfully activated version. Before
either exists, the comparison is an empty source tree.

Each file is `{ path, lines: [{ kind, text }] }`, directly usable by `CodeDiff`
from `@k2b/ui`. `same` rows belong to both versions, `del` to the previous
version and `add` to the proposed version. All rows and all files are present,
including unchanged files and deleted files. Rows contain no newline character;
a trailing empty row preserves a final newline. There is no hidden context or
hunk truncation. If a detailed comparison exceeds Core's existing 100 ms diff
budget, the complete old file is shown as removed and the complete new file as
added.

The standard capability result budget still applies. A comparison too large
for that transport fails visibly rather than returning a partial diff. The
stored approval content contains the complete comparison, readable through
[the shared approval content route](/en/docs/identity/approvals#approval-routes).
For source inspection, `core.code.version.read` also provides bounded chunks.

For any comparison, including versions without an approval request, use
`core.code.version.diff.read({ codeId, versionId, comparisonVersionId, offset?,
length? })`. The comparison ID is another version of the same Code or null for
an empty tree. It returns `{ content: { text, nextOffset } }`: bounded UTF-16
chunks of the complete `CodeDiffFile[]` JSON. Follow `nextOffset` until null and
parse the concatenated text before rendering. Changed files use full replacement
rows in this reader, making chunks deterministic; unchanged files retain `same`
rows. No source row or file is omitted. `length` defaults to and is at most
65,536. Readers need the same Code read permission as source inspection.

A binding contains `codeId`, `versionId`, `sourceHash`, `bundleHash`,
`manifestHash`, `comparisonVersionId`, `comparisonSourceHash` and
`comparisonBundleHash`. Keep it unchanged for the decision. A changed comparison
sets `staleComparison: true`; submit and review a new version. Decided versions
retain the original reviewed comparison even after the baseline advances.

## Decide through the shared approval

A pending version appears in the platform's **Waiting for you** list for Cloud
administrators. Its request has kind `code_version`, assurance `confirm`, and
reason `changes_access`. The stored complete content contains the hash binding,
manifest and full source difference. Existing approval surfaces show it as
passive plain JSON; the Code administration surface can render its full file
rows as `CodeDiff`.

`core.code.version.approve(binding)` and
`core.code.version.reject(binding)` use that same platform request and current
Cloud-admin authority. Shared approval cards and Cloud Login call the same
transactional owner handler. The first decision wins; repeating the same
accepted decision returns its existing receipt.

Core refuses changed hashes with `code_hash_mismatch`, a superseded version
with `code_version_stale`, unavailable or deleting Code with
`code_version_unavailable`, and a changed comparison or review with
`code_comparison_stale`. The platform decision and domain evidence roll back
together. The shared browser route returns a conflict; Cloud Login declines
the stale decision. Review the current version and submit again. A successful
submission atomically cancels older pending requests for the same Code, removing
their cards from Waiting for you. Both approval and rejection still require the
unchanged comparison.

An author cannot approve their own version when another active human Cloud
administrator exists. The platform's sole-admin rule is the only exception:
a sole active human Cloud administrator can approve their own version after
recent full browser sign-in or through Cloud Login. The shared question shows:

> Du gibst deinen eigenen Code frei. Es gibt keinen zweiten Cloud-Admin, der ihn prüft.

Machine accounts and expired administrators do not count as a second person.
The platform counts and locks the administrator population in the decision
transaction. Adding a second administrator blocks new self-approvals immediately;
an earlier approval stays valid.

Core stores `sole_admin` in its durable decision and approved/rejected audit
metadata. German version receipts label a self-approval
**selbst freigegeben (einziger Admin)**. Approvals remain bound to the exact
source, bundle and manifest. A revoked deciding device or a changed sign-out
epoch prevents subsequent use of that approval.

## List, pause and resume

`core.code.version.list({ codeId, before?, limit? })` returns newest-first
submission receipts and `nextBefore`. `before` is an exclusive version number;
`limit` defaults to 20 and accepts at most 50. Pages may stop earlier at the
transport byte budget; follow `nextBefore` until null. Decision receipts survive pruning
of transient platform approval requests. An undecided expired request has
`status: "expired"`; submit again to request a new review.

`core.code.pause({ codeId })` pauses future execution of the active version.
`core.code.resume({ codeId })` checks current policy and live approval evidence
before resuming that same version. Events arriving during the pause are not
replayed. A pending newer version remains pending. Cloud administrators and
Code editors may pause or resume with write authority; phone sessions cannot.
Their reviews name the Code and exact active version, show the state change and
explain how future events are handled. Resume also checks current approval and
policy before presenting that change.
Activate a version before using either operation.

## Maintainer integration

Core owns the services and tables. Other applications consume capabilities.
Every push caller uses `submitCodeVersion`; `createCodeVersion` is an internal
storage primitive and does not implement submission or approval lifecycle.
`packages/core/src/code/index.ts` exports:

- `codeVersionContracts` and `CodeVersionSubmission`;
- `CodeVersionBinding`, `CodeVersionDecision`, `CodeVersionDiffFile` and their
  schemas;
- `submitCodeVersion`, `diffCodeVersion`, `listCodeVersions`,
  `decideCodeVersion`, `readCodeVersionDiff` and `setCodePaused` for permission-aware callers;
- `reviewCodeVersionSubmission`, `reviewCodeExecutionChange` and
  `reviewCodeVersionDecision` for read-only capability reviews;
- `startCodeVersionApprovals` and `applyCodeVersionDecision` for the lifecycle
  owner of the platform decision handler;
- `requireCodeVersionApproval(code, versionId, tx)` for activation and dispatch.
  Hold policy then Code locks, or use one consistent read snapshot. This checks
  current classifications, hashes, decision and device/sign-out revocation;
- `recordCodeVersionBaseline(codeId, versionId, tx)` for activation to call only in
  the transaction of a successful activation, after acquiring the Code lock.
  It records comparison history and grants no execution or resource authority.

The additive migration creates `code.version_submissions`,
`code.version_decisions` and `code.version_baselines`. Submissions and decisions
are immutable; deleting the approving user erases decision attribution and
conservatively revokes that approval for future activation or resume. Requests may be
pruned without deleting durable decisions or source evidence. No Assistant data
is rewritten.

Audit events are `core.code.version.submitted`, `core.code.version.approved`,
`core.code.version.rejected`, `core.code.paused` and `core.code.resumed`.
Decision events include both hashes, the manifest and comparison binding,
request ID, channel and `sole_admin`; a sole-admin approval uses reason
`self_approved_sole_admin`. Audit events contain no source or bundle bodies.
