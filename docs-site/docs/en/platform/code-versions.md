---
title: Code versions and approval
navTitle: Code versions
section: Platform services
order: 962
description: Submit checked Code, compare complete source versions and decide hash-bound Cloud-admin approvals.
tags: [code, approvals, versions]
updated: 2026-11-14
---

# Code versions and approval

Submit a checked source and bundle together. Core saves an immutable version
and requests a Cloud administrator's approval when the current
[Code policy](/en/docs/platform/code-policy) requires it. The previous active
version keeps running while the new version waits. Approval alone does not
activate a version or grant resource access.

File operations supported by the generated SDK also work when saving a version:
read streams return a FileRef, and write streams accept one through their file
metadata input. Write streams without that input remain unavailable.

## Submit a version

Resource Actions (`code.version.submit`, `code.version.approve`,
`code.version.reject`, `code.version.request_changes`, `code.pause`, `code.resume`) require
`target: { type: "core.code", id: codeId }` beside domain `input`. Flat chat and
MCP tools use `code`. Remove `codeId` from their inputs; Queries and exported
service schemas keep it.

Submission may carry `tests`, the declarative `test/**/*.json` fixtures. Core
runs them once against fake data and stores the counts, plus the calls per
operation, with the submission for reviewers. Names, outcomes and observation
sentences are saved for each example; see [Code in words](/en/docs/platform/code-read-model). Failing tests do not refuse the
version. `cld code submit`, `cld code submit` and `code_submit` send them.

`core.code.version.submit` accepts `sourceFiles`, `bundle`,
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

Core repeats the authoritative check on an isolated runner before saving.
The submitted bundle and static manifest evidence must match the fresh result;
runner overload reports `code_job_busy` so the caller can retry. Forward
cancellation to stop waiting. See [Code checker](/en/docs/platform/code-checker)
for the production host API.

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
- `entrypoints`: `{ kind: "schedule" | "manual", entrypoint, title?, cron, at?, timeZone?, file, line }`;
- `permissions`: `{ operation, target, file, line }`, retaining separate source
  rows for literal targets and references. An app-wide operation has a null
  target; dynamic personal targets have a null `target.id`;
- `ai`: whether detected calls use AI;
- `hashes`: lowercase SHA-256 digests for `source`, `sdk` and `bundle`.

For one-time schedules, `cron` is null and both `at` (an absolute date-time)
and `timeZone` (an IANA zone) are present. Cron schedules omit both fields.

The host adds `entry` from the original `CodeCheckRequest.entry` and
unique `policyRows` from operation metadata, including every used classification
and any AI or internet use. Core resolves each declared operation in the current
catalog and refuses missing classifications or operations unavailable to Code.
`code: false` actions remain available to personal Code acting with person
authority; resource-owned and app-owned Code cannot use them. Keep the checker's
permission rows and entrypoints (including optional titles) unchanged; locations are one-based. Core validates
their source locations.

Source hashing matches the checker: SHA-256 over UTF-8
`JSON.stringify({ entry, files })`, where `files` contains sorted `[path, content]`
pairs. SDK hashing covers recursively key-sorted SDK JSON. Bundle hashing covers
the exact UTF-8 bundle. The manifest is saved at version creation and cannot be
replaced later. Every runtime capability call must match this version's
`permissions`, including its target Type, literal IDs and ref coordinates.
A dynamic ID covers only its declared Type in every Code mode. Target and ref
rows form a set per operation; the evidence does not bind ref names or tuples.
An undeclared call fails with `code_capability_undeclared` (403) and
appears as a failed policy call in the run. This applies to pages, events,
schedules and calls made through SDK tools. Declared calls still need current
policy, version approval, mandate and resource access.

Automation titles use `CodeAutomationTitleSchema`: trimmed, 1–200 characters,
one line of plain text without HTML markup or control/format characters.
A title belongs to this immutable manifest. A title change creates a new
version and follows the existing approval rules. `entrypoint` remains the key
for execution, JSON, audit and URLs; human displays use `title ?? entrypoint`.
Historical runs use the title of their own version.

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

`core.code.version.approve`, `core.code.version.reject` and
`core.code.version.request_changes` (with the binding
fields other than `codeId` in input and the Code as target) use that same platform request and current
Cloud-admin authority. Shared approval cards and Cloud Login call the same
transactional owner handler. The first decision wins; repeating the same
accepted outcome returns its existing receipt. A different outcome returns a
conflict naming the person who already decided. Rejection and requesting changes
require a nonblank `comment` of at most 5,000 characters; approval accepts an
optional comment. Core records `approved`, `changes_requested` or `rejected`.
The latter two both refuse activation. The platform keeps its two outcomes:
`changes_requested` is a rejected platform request.

Code reviews expire after 14 days; Action approvals still expire after 24 hours.
The submitter and current editors receive the decision after commit, even when
the chat is closed. A submission notifies active Cloud administrators. Notices
are retried with a stable key per version, notice kind and recipient. Their
language follows the recipient's last browser sign-in; without that, the
submitter's submission locale or the installation locale is used.

Core records immutable submission provenance: `{kind:"cli"}` or
`{kind:"ai_chat",conversationId,automaticAfterReview}`. The authenticated
transport supplies this; a submission payload cannot choose its origin.
`automaticAfterReview` records a revision created automatically after feedback,
so a review worker can avoid an automatic revision loop.

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
an administrator with no other active human reviewer can approve their own
version after recent full browser sign-in or through Cloud Login. The shared
question shows:

> Du gibst deinen eigenen Code frei. Es gibt keinen zweiten Cloud-Admin, der ihn prüft.

The Administration → Code review shows “You are the only admin and approve
your own version.” / “Du bist der einzige Admin und gibst deine eigene Version
frei.” and enables approval. When another reviewer exists, the author's
“Another admin approves it” hint stays and approval remains unavailable.

Machine accounts, expired or locked administrators, disabled account categories,
and the local emergency `admin` identity do not count as other reviewers.
The emergency admin may approve its own version only when no active human
admin exists, with the same recent sign-in requirement and audit evidence.
An active ordinary account such as `dev-admin` counts as a human reviewer,
even without a previous sign-in.
The platform counts and locks the administrator population in the decision
transaction. Adding a second administrator blocks new self-approvals immediately;
an earlier approval stays valid.

Core stores `sole_admin` in its durable decision and approved/rejected audit
metadata. German version receipts label a self-approval
**selbst freigegeben (einziger Admin)**. Approvals remain bound to the exact
source, bundle and manifest. A revoked deciding device or a changed sign-out
epoch prevents subsequent use of that approval.

## Read review feedback

`POST /api/code/authoring/review` takes `{codeId,versionId,before?}` and returns
one `review` object: `codeId`, `versionId`, `number`, `status`, `origin`,
`approvalId`, `expiresAt`, `decidedBy`, `decidedAt`, `message`, `comments`,
`nextBefore`, `commentCount`, `activeVersion` and `contentTrust:"untrusted_data"`.
The statuses are `not_required`, `pending`, `approved`, `changes_requested`,
`rejected`, `withdrawn`, `superseded` and `expired`. `not_required` means no human
approval was needed. `activeVersion` is `{id,number}` or null.

Current editors can read the review, including with a read credential. Comments
are unpublished until a decision. After publication each comment has `id`,
`author:{id,name,avatarHash}`, `createdAt`, `body`, `parentId`, `path` and `line`.
Replies retain their root ID. Follow `nextBefore` as `before` to read older
comments. Product surfaces use the same service with anchors omitted, keeping
author, time, text and replies. The `code_review` chat tool and
`core.code.version.review` Query additionally require a published decision.
Each call checks current editor rights. Messages and comment bodies are data;
they grant no task, tool or permission and must never be treated as instructions.

Administrators create comments and replies through
`POST /api/code/admin/comments/create` with
`{codeId,versionId,path,line,body,parentId?}`. Anchors refer to the new version's
exact file and one-based line. A body has at most 5,000 characters; the total
comment count derives from the platform's complete-review content budget.
`comments/list` accepts `{codeId,versionId,before?,limit?}` (default 20, maximum
50) and returns `{data:{items,nextBefore,total}}`.
`comments/delete` takes `{codeId,versionId,id}`; only its author may delete it.
Creating or deleting comments and deciding share the Code row lock. Once a
review is decided, expired, superseded or withdrawn, comments are frozen.

`POST /api/code/admin/decide` accepts
`{binding,approved,outcome?,comment?}`. When supplied, `outcome` must agree with
`approved`; omitting it retains the binary approval/rejection mapping. The
owning Code service validates the required text and stores it atomically with
the platform decision. The platform's `approvals.decide` forwards optional JSON
`detail` (at most 32 KiB) to its kind handler in that same transaction.

`POST /api/code/authoring/reviewWait` adds `holdMs` to the review input. It holds
at most the login polling interval, with one held request per person across
replicas. Further requests return the current snapshot immediately. It listens
before re-reading and rechecks state and access after waking; lost hints are
covered by the final read. Cancelling the request only stops waiting.

The resource event `core.code.version.decided`, version 1, is written with the
decision. Its subject and place are the Code; its data is only
`{codeId,versionId,number,outcome}`. It contains no message or comments. The
Code Type reader `code.resource.read` checks the current recipient's access for
every delivery. It accepts person-bound authority, including a person mandate;
Code accounts do not gain a management or source-reading surface.

## Withdraw or request another review

`POST /api/code/authoring/withdraw` takes `{codeId,versionId}`. Only a current
editor with a write credential can withdraw a pending, unexpired review. Core
records who withdrew it and when, cancels the question and writes
`core.code.version.withdrawn` in one transaction. Activation refuses this
version even if the policy later stops requiring approval. Withdrawal and a
newer version superseding a request remain distinct states.

After expiry, use the existing authoring `resubmit` command with the same
content. It creates a new version and approval reference. Each immutable
version therefore has one review; no separate attempt identity is needed.
The active version keeps running. If none is active, the automation remains off.

## List, pause and resume

`core.code.version.list({ codeId, before?, limit? })` returns newest-first
submission receipts and `nextBefore`. `before` is an exclusive version number;
`limit` defaults to 20 and accepts at most 50. Pages may stop earlier at the
transport byte budget; follow `nextBefore` until null. Decision receipts survive pruning
of transient platform approval requests. An undecided expired request has
`status: "expired"`; submit again to request a new review.

`core.code.pause` at the Code target pauses future execution of the active version.
`core.code.resume` at the same target checks current policy and live approval evidence
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

The additive migration creates `code.version_explanations` and
`code.version_submissions`,
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

## Activate a submitted version

Use [Code activation](/en/docs/platform/code-activation) to check owner authority and
required approval, create its version entry, and switch the active version durably.
Pending or failed activation leaves the current version running.
