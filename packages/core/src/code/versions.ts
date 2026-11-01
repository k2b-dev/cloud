import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityActionCallReview,
  CapabilityActionCallReviewSchema,
  capabilityActionPolicy,
  type NormalizedCapabilityCall,
} from "@k2b/cloud/contracts";
import { isAppSessionActor } from "@k2b/cloud/server";
import { audit, canRepairAppAccess } from "@k2b/cloud/services";
import {
  APPROVAL_MAX_WAIT_MS,
  type ApprovalDecisionActor,
  ApprovalDecisionConflictError,
  type ApprovalRequest,
  approvalArgsDigest,
  approvalDecisionChannel,
  approvalReviewDigest,
  approvals,
  codeVersionSoleAdminNotice,
  registerApprovalDecisionHandler,
} from "@k2b/cloud/services/approvals";
import type { SQL } from "bun";
import type { z } from "zod";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { CODE_INLINE_JSON_BYTES, type Code, type CodeSourceFiles, type CodeVersion, CodeVersionSchema } from "./contracts";
import { readCodePolicyGroups, readCodePolicySnapshot, replaceCodePolicyCoverage, requireCodePolicyAdmin } from "./policy";
import { codePolicyRow } from "./policy-contracts";
import { effective } from "./policy-effective";
import { codeSettings } from "./settings";
import {
  codeBundleHash,
  codeSourceHash,
  codeTextChunk,
  createCodeVersion,
  findCode,
  lockCodeForEdit,
  readCode,
  readCodeVersion,
} from "./store";
import {
  CodeCheckedVersionManifestSchema,
  type CodeVersionBinding,
  CodeVersionBindingSchema,
  type CodeVersionSubmission,
  codeVersionContracts,
} from "./version-contracts";
import { codeVersionDiff } from "./version-diff";
import { codeVersionMessages } from "./version-messages";

/** Stable refusal codes for CLI, chat tools and activation. Conflict details contain the current full comparison. */
export type CodeVersionErrorCode =
  | "code_version_unavailable"
  | "code_version_conflict"
  | "code_hash_mismatch"
  | "code_comparison_stale"
  | "code_sends_not_yet"
  | "code_approval_required"
  | "code_approval_revoked"
  | "code_policy_never"
  | "code_version_stale"
  | "code_manifest_invalid";
/** A version refusal returned unchanged by capabilities and as 409 by shared decision routes. */
export class CodeVersionError extends ApprovalDecisionConflictError<CodeVersionErrorCode> {}
type Snapshot = {
  id: string;
  source_files: CodeSourceFiles;
  bundle: string;
  source_hash: string;
  bundle_hash: string;
  manifest: unknown;
  created_by: string | null;
};
async function versionSnapshot(codeId: string, versionId: string, db: SQL): Promise<Snapshot> {
  const [version] = await db<Snapshot[]>`SELECT * FROM code.versions WHERE code_id=${codeId} AND id=${versionId}::uuid`;
  if (!version) throw new CodeDataError("NOT_FOUND", "Code version not found.");
  return version;
}
function manifestFor(version: Snapshot) {
  const parsed = CodeCheckedVersionManifestSchema.safeParse(version.manifest);
  if (!parsed.success) throw new CodeVersionError("code_manifest_invalid", "A complete checker manifest is required.");
  const manifest = parsed.data;
  if (
    codeSourceHash(version.source_files, manifest.entry) !== version.source_hash ||
    codeBundleHash(version.bundle) !== version.bundle_hash ||
    manifest.hashes.source !== version.source_hash ||
    manifest.hashes.bundle !== version.bundle_hash
  )
    throw new CodeVersionError("code_hash_mismatch", "Source or bundle hash does not match the immutable version.");
  return manifest;
}
async function baseline(code: Code, db: SQL): Promise<Snapshot | null> {
  const [row] = await db<{ version_id: string }[]>`SELECT version_id FROM code.version_baselines WHERE code_id=${code.id}`;
  const id = row?.version_id ?? code.activeVersionId;
  return id ? versionSnapshot(code.id, id, db) : null;
}
function bindingFor(codeId: string, version: Snapshot, comparison: Snapshot | null): CodeVersionBinding {
  return {
    codeId,
    versionId: version.id,
    sourceHash: version.source_hash,
    bundleHash: version.bundle_hash,
    manifestHash: approvalArgsDigest(version.manifest),
    comparisonVersionId: comparison?.id ?? null,
    comparisonSourceHash: comparison?.source_hash ?? null,
    comparisonBundleHash: comparison?.bundle_hash ?? null,
  };
}
const sameBinding = (a: CodeVersionBinding, b: CodeVersionBinding) => approvalArgsDigest(a) === approvalArgsDigest(b);
const approvalCall = ({ codeId, ...input }: CodeVersionBinding): NormalizedCapabilityCall => ({
  capability: "core.code.version.approve",
  target: { type: "core.code", id: codeId },
  refs: {},
  input,
});
const messages = (context: Pick<CodeContext, "locale">) => codeVersionMessages.resolve(context.locale ? [context.locale] : []);
const codeReviewSlot = (code: Code) => ({
  kind: "object" as const,
  title:
    code.title
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200)
      .toWellFormed() || "—",
});
function reviewFor(
  code: Code,
  binding: CodeVersionBinding,
  version: Snapshot,
  comparison: Snapshot | null,
  context: Pick<CodeContext, "locale">,
): CapabilityActionCallReview {
  const { t, locale } = messages(context);
  return {
    locale,
    sentence: { action: t.action, running: t.running, done: t.done, confirm: t.confirm, decline: t.decline, rejected: t.declined },
    slots: { code: codeReviewSlot(code), version: { kind: "text", value: version.id } },
    ask: "changes_access",
    // Plain JSON is a passive complete snapshot, readable in every existing approval surface.
    // C22 additionally renders these same full rows through CodeDiff.
    content: {
      kind: "page",
      title: t.content,
      format: "plain",
      body: JSON.stringify({
        binding,
        manifest: version.manifest,
        files: codeVersionDiff(comparison?.source_files ?? {}, version.source_files),
      }),
    },
  };
}
async function validateOperationRows(
  manifest: z.infer<typeof CodeCheckedVersionManifestSchema>,
  context: CodeContext,
  ownerKind: Code["owner"]["kind"],
) {
  if (Buffer.byteLength(JSON.stringify(manifest)) > (await codeSettings.get("core.code.manifest_bytes")))
    throw new CodeDataError("BAD_INPUT", "Code manifest exceeds storage limits.");
  for (const appId of new Set(manifest.permissions.map((permission) => permission.operation.split(".")[0]!))) {
    context.signal?.throwIfAborted();
    const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority);
    if (!catalog.ok) throw new CodeVersionError("code_version_unavailable", "Operation catalog is unavailable. Retry submission.");
    if (!catalog.data) throw new CodeVersionError("code_manifest_invalid", "Operation catalog is unavailable.");
    for (const permission of manifest.permissions.filter((permission) => permission.operation.startsWith(`${appId}.`))) {
      const localId = permission.operation.slice(appId.length + 1);
      const query = catalog.data.manifest.queries.find((operation) => operation.localId === localId);
      const action = catalog.data.manifest.actions.find((operation) => operation.localId === localId);
      if ((!query && !action) || query?.stream || action?.stream || (action?.code === false && ownerKind !== "person"))
        throw new CodeVersionError("code_manifest_invalid", "Manifest operation is unavailable to Code.");
      const row = codePolicyRow(query ? "query" : "action", capabilityActionPolicy(catalog.data.manifest, localId));
      if (row === "ask_sends") throw new CodeVersionError("code_sends_not_yet", "Unattended sending is available in Phase 3.");
      if (!manifest.policyRows.includes(row))
        throw new CodeVersionError("code_manifest_invalid", "Manifest classifications do not cover the current operation policy.");
    }
  }
}
function checkedSubmission(raw: z.input<typeof codeVersionContracts.submit.input>, context: CodeContext) {
  const input = codeVersionContracts.submit.input.parse(raw);
  codePerson(context, true);
  if (isAppSessionActor(context.authority.actor)) throw new CodeDataError("FORBIDDEN", "Phone sessions cannot submit Code authority.");
  if (
    input.manifest.hashes.source !== codeSourceHash(input.sourceFiles, input.manifest.entry) ||
    input.manifest.hashes.bundle !== codeBundleHash(input.bundle)
  )
    throw new CodeVersionError("code_hash_mismatch", "Checker hashes do not match the submitted source and bundle.");
  if (input.manifest.policyRows.includes("ask_sends"))
    throw new CodeVersionError("code_sends_not_yet", "Unattended sending is available in Phase 3.");
  if (!Object.hasOwn(input.sourceFiles, input.manifest.entry))
    throw new CodeVersionError("code_manifest_invalid", "Checker entry does not exist.");
  for (const permission of [...input.manifest.permissions, ...input.manifest.entrypoints]) {
    const source = input.sourceFiles[permission.file];
    if (!Object.hasOwn(input.sourceFiles, permission.file) || source === undefined || permission.line > source.split("\n").length)
      throw new CodeVersionError("code_manifest_invalid", "Permission source location does not exist.");
  }
  return input;
}
/** Read-only submission preview: exact proposed content, owning Code and current saved base. */
export async function reviewCodeVersionSubmission(
  raw: z.input<typeof codeVersionContracts.submit.input>,
  context: CodeContext,
): Promise<CapabilityActionCallReview> {
  const input = checkedSubmission(raw, context);
  const { code } = await readCode(input.codeId, context);
  await requireCodePermission(code, context, true);
  await validateOperationRows(input.manifest, context, code.owner.kind);
  const comparison = input.baseVersionId ? await versionSnapshot(code.id, input.baseVersionId, sql) : null;
  const { t, locale } = messages(context);
  const review: CapabilityActionCallReview = {
    locale,
    slots: { code: codeReviewSlot(code) },
    sentence: { action: t.submitAction, running: t.submitRunning, done: t.submitDone, confirm: t.submitConfirm, decline: t.cancel },
    consequences: [{ text: t.submitEffect }],
    content: {
      kind: "page",
      title: t.content,
      format: "plain",
      body: JSON.stringify({
        codeId: code.id,
        baseVersionId: input.baseVersionId,
        activeVersionId: code.activeVersionId,
        manifest: input.manifest,
        bundle: input.bundle,
        files: codeVersionDiff(comparison?.source_files ?? {}, input.sourceFiles, "replacement"),
      }),
    },
  };
  if (!CapabilityActionCallReviewSchema.safeParse(review).success)
    throw new CodeDataError("BAD_INPUT", "The complete submission review exceeds the approval content budget.");
  return review;
}
/** Submit the exact checked source and bundle atomically. Pending approval never changes the running version. */
export async function submitCodeVersion(
  raw: z.input<typeof codeVersionContracts.submit.input>,
  context: CodeContext,
): Promise<CodeVersionSubmission> {
  const input = checkedSubmission(raw, context);
  const author = codePerson(context, true);
  const { code: authorizedCode } = await readCode(input.codeId, context);
  await validateOperationRows(input.manifest, context, authorizedCode.owner.kind);
  return sql.begin(async (tx) => {
    // Match C5's request-before-policy-before-Code order. Never wait on a request while holding Code.
    const superseded = await tx<{ id: string }[]>`SELECT r.id FROM approvals.requests r
      JOIN code.version_submissions s ON s.approval_id=r.id
      WHERE s.code_id=${input.codeId} AND r.kind='code_version' AND r.status='pending'
      ORDER BY r.id FOR UPDATE OF r`;
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    const code = await lockCodeForEdit(input.codeId, context, tx);
    const [latest] = await tx<{ id: string }[]>`SELECT id FROM code.versions WHERE code_id=${code.id} ORDER BY number DESC LIMIT 1`;
    if ((latest?.id ?? null) !== input.baseVersionId) {
      const before = input.baseVersionId ? await versionSnapshot(code.id, input.baseVersionId, tx) : null;
      const after = latest ? await versionSnapshot(code.id, latest.id, tx) : null;
      throw new CodeVersionError("code_version_conflict", messages(context).t.conflict, {
        latestVersionId: latest?.id ?? null,
        files: codeVersionDiff(before?.source_files ?? {}, after?.source_files ?? {}),
        diffRead: {
          query: "core.code.version.diff.read",
          input: { codeId: code.id, versionId: latest?.id ?? null, comparisonVersionId: input.baseVersionId },
        },
      });
    }
    await approvals.cancel(
      superseded.map((row) => row.id),
      tx,
    );
    const version = await createCodeVersion({ ...input, entry: input.manifest.entry }, context, tx);
    const snapshot = await versionSnapshot(code.id, version.id, tx);
    const comparison = await baseline(code, tx);
    const binding = bindingFor(code.id, snapshot, comparison);
    const policy = await readCodePolicySnapshot(tx);
    const groups = await readCodePolicyGroups(code.owner.kind === "person" ? code.owner.userId : author.id, tx);
    const rows = input.manifest.policyRows.map((row) => effective(row, code.owner, policy.definition, groups));
    if (rows.some((row) => row.value === "never"))
      throw new CodeVersionError("code_policy_never", "The current Code policy forbids this version.");
    let approvalId: string | null = null;
    let reviewDigest: string | null = null;
    if (rows.some((row) => row.value === "admin")) {
      const review = reviewFor(code, binding, snapshot, comparison, context);
      if (!CapabilityActionCallReviewSchema.safeParse(review).success)
        throw new CodeDataError("BAD_INPUT", "The complete version review exceeds the approval content budget.");
      const asked = await approvals.request(
        {
          kind: "code_version",
          appId: "core",
          action: "code.version.approve",
          requester: { kind: "code_version", ref: version.id, appId: "core", title: code.title, href: `/me/approvals?app=core` },
          authorUserId: author.id,
          approverRole: "admin",
          sentence: review.sentence.action,
          input: approvalCall(binding),
          review,
          expiresInMs: APPROVAL_MAX_WAIT_MS,
        },
        tx,
      );
      if (!asked.ok) throw new CodeDataError("CONFLICT", "Version approval request already exists.");
      approvalId = asked.id;
      reviewDigest = approvalReviewDigest(review);
    }
    await tx`INSERT INTO code.version_submissions(version_id,code_id,binding,approval_id,review_digest)
      VALUES(${version.id}::uuid,${code.id},${JSON.stringify(binding)}::text::jsonb,${approvalId}::uuid,${reviewDigest})`;
    await audit.record(
      {
        action: "core.code.version.submitted",
        outcome: "allowed",
        actor: { userId: author.id },
        target: { type: "code", id: code.id },
        requestId: context.requestId,
        metadata: { ...binding, approvalId, policyRevision: policy.revision },
      },
      tx,
    );
    return { version, binding, approvalId, status: approvalId ? "pending" : "submitted", decision: null };
  });
}
/** Compare against the last approved or successfully activated version, including every row of every file. */
export async function diffCodeVersion(input: z.infer<typeof codeVersionContracts.diff.input>, context: CodeContext) {
  await readCode(input.codeId, context);
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const code = await findCode(input.codeId, tx);
    if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
    const version = await versionSnapshot(code.id, input.versionId, tx);
    const manifest = manifestFor(version);
    const [submission] = await tx<{ binding: CodeVersionBinding; decided: boolean }[]>`
      SELECT s.binding,EXISTS(SELECT 1 FROM code.version_decisions d WHERE d.version_id=s.version_id) AS decided
      FROM code.version_submissions s WHERE s.version_id=${version.id}::uuid`;
    const comparison = submission?.decided
      ? submission.binding.comparisonVersionId
        ? await versionSnapshot(code.id, submission.binding.comparisonVersionId, tx)
        : null
      : await baseline(code, tx);
    const binding = bindingFor(code.id, version, comparison);
    return {
      binding,
      staleComparison: !submission || !sameBinding(binding, submission.binding),
      files: codeVersionDiff(comparison?.source_files ?? {}, version.source_files),
      permissions: manifest.permissions,
      policyRows: manifest.policyRows,
    };
  });
}
/** Bounded, deterministic UTF-16 chunks of the complete CodeDiffFile[] JSON, including every row.
 * Assemble all chunks before rendering. Changed files use full replacement rows so immutable inputs always yield identical chunks.
 */
export async function readCodeVersionDiff(input: z.infer<typeof codeVersionContracts.diffRead.input>, context: CodeContext) {
  await readCode(input.codeId, context);
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const version = await versionSnapshot(input.codeId, input.versionId, tx);
    const comparison = input.comparisonVersionId ? await versionSnapshot(input.codeId, input.comparisonVersionId, tx) : null;
    return {
      content: codeTextChunk(
        JSON.stringify(codeVersionDiff(comparison?.source_files ?? {}, version.source_files, "replacement")),
        input.offset,
        input.length,
      ),
    };
  });
}
async function submissionFor(codeId: string, versionId: string, context: CodeContext, db: SQL = sql): Promise<CodeVersionSubmission> {
  const { version } = await readCodeVersion({ codeId, versionId, offset: 0, length: 1 }, context);
  const [row] = await db<SubmissionRow[]>`
    SELECT s.*,r.status,(r.expires_at>statement_timestamp()) AS unexpired,d.approved,d.sole_admin,d.decided_by,d.decided_at FROM code.version_submissions s
      LEFT JOIN approvals.requests r ON r.id=s.approval_id LEFT JOIN code.version_decisions d ON d.version_id=s.version_id
      WHERE s.code_id=${codeId} AND s.version_id=${versionId}::uuid`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code submission not found.");
  return submissionReceipt(version, row, context);
}
type SubmissionRow = {
  binding: CodeVersionBinding;
  approval_id: string | null;
  status: string | null;
  unexpired: boolean | null;
  approved: boolean | null;
  sole_admin: boolean | null;
  decided_by: string | null;
  decided_at: Date | null;
};
function submissionReceipt(version: CodeVersion, row: SubmissionRow, context: CodeContext): CodeVersionSubmission {
  const { t } = messages(context);
  return {
    version,
    binding: CodeVersionBindingSchema.parse(row.binding),
    approvalId: row.approval_id,
    status:
      row.approved === true
        ? "approved"
        : row.approved === false
          ? "rejected"
          : row.approval_id === null
            ? "submitted"
            : row.status === "pending" && row.unexpired
              ? "pending"
              : row.status === "cancelled"
                ? "cancelled"
                : "expired",
    decision: row.decided_at
      ? {
          approved: row.approved === true,
          soleAdmin: row.sole_admin === true,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at.toISOString(),
          label: row.sole_admin ? t.soleAdmin : row.approved ? t.approved : t.rejected,
        }
      : null,
  };
}
/** Bounded version history with durable decision receipts, including the sole-admin label. */
export async function listCodeVersions(input: z.infer<typeof codeVersionContracts.list.input>, context: CodeContext) {
  await readCode(input.codeId, context);
  const rows = await sql<(SubmissionRow & { version: unknown; number: number })[]>`
    SELECT v.number,s.*,r.status,(r.expires_at>statement_timestamp()) AS unexpired,d.approved,d.sole_admin,d.decided_by,d.decided_at,
      jsonb_build_object('id',v.id,'codeId',v.code_id,'number',v.number,
        'files',ARRAY(SELECT path FROM jsonb_object_keys(v.source_files) path ORDER BY path COLLATE "C"),
        'sourceHash',v.source_hash,'bundleHash',v.bundle_hash,'sourceBytes',v.source_bytes,'bundleBytes',v.bundle_bytes,
        'manifestAvailable',v.manifest IS NOT NULL,'createdBy',v.created_by,'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS version
    FROM code.versions v JOIN code.version_submissions s ON s.version_id=v.id
      LEFT JOIN approvals.requests r ON r.id=s.approval_id LEFT JOIN code.version_decisions d ON d.version_id=v.id
    WHERE v.code_id=${input.codeId} AND (${input.before ?? null}::int IS NULL OR v.number<${input.before ?? null})
    ORDER BY v.number DESC LIMIT ${input.limit + 1}`;
  const items: CodeVersionSubmission[] = [];
  for (const row of rows.slice(0, input.limit)) {
    const version = CodeVersionSchema.parse(row.version);
    version.files.sort();
    const item = submissionReceipt(version, row, context);
    // Reserve the existing inline-content budget for the capability envelope and cursors.
    if (Buffer.byteLength(JSON.stringify([...items, item])) > CAPABILITY_MAX_RESULT_BYTES - CODE_INLINE_JSON_BYTES) {
      if (!items.length) throw new CodeDataError("BAD_INPUT", "Version metadata exceeds the response budget.");
      break;
    }
    items.push(item);
  }
  return { items, nextBefore: rows.length > items.length ? items.at(-1)!.version.number : null };
}

/** C5 invokes this only for its winning decision. Both domain evidence and audit commit with the platform request. */
export async function applyCodeVersionDecision(tx: SQL, request: ApprovalRequest, actor: ApprovalDecisionActor): Promise<void> {
  const [submission] = await tx<
    { code_id: string; version_id: string; binding: CodeVersionBinding; review_digest: string | null }[]
  >`SELECT * FROM code.version_submissions WHERE approval_id=${request.id}::uuid`;
  if (!submission) throw new CodeVersionError("code_version_unavailable", "Code submission is no longer available.");
  await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
  await tx`SELECT id FROM code.codes WHERE id=${submission.code_id} FOR UPDATE`;
  const code = await findCode(submission.code_id, tx);
  if (!code || code.state === "deleting") throw new CodeVersionError("code_version_unavailable", "Code is no longer available.");
  const version = await versionSnapshot(code.id, submission.version_id, tx);
  const manifest = manifestFor(version);
  const [latest] = await tx<{ id: string }[]>`SELECT id FROM code.versions WHERE code_id=${code.id} ORDER BY number DESC LIMIT 1`;
  if (latest?.id !== version.id) throw new CodeVersionError("code_version_stale", "A newer version must be reviewed.");
  const comparison = await baseline(code, tx);
  const binding = bindingFor(code.id, version, comparison);
  if (
    binding.sourceHash !== submission.binding.sourceHash ||
    binding.bundleHash !== submission.binding.bundleHash ||
    binding.manifestHash !== submission.binding.manifestHash
  )
    throw new CodeVersionError("code_hash_mismatch", "Approval hashes do not match the immutable version.");
  if (!sameBinding(binding, submission.binding) || request.argsDigest !== approvalArgsDigest(approvalCall(binding)))
    throw new CodeVersionError("code_comparison_stale", "The comparison changed. Submit and review a new version.");
  if (
    !request.details ||
    request.reviewDigest !== submission.review_digest ||
    approvalReviewDigest(request.details) !== submission.review_digest
  )
    throw new CodeVersionError("code_comparison_stale", "The reviewed version snapshot changed.");
  if (!request.decidedByUserId || !request.approverAuthEpoch) throw new CodeDataError("FORBIDDEN", "Decision evidence is missing.");
  await tx`INSERT INTO code.version_decisions(version_id,binding,approved,sole_admin,decided_by,decided_via,decided_device_id,auth_epoch)
    VALUES(${version.id}::uuid,${JSON.stringify(binding)}::text::jsonb,${request.status === "approved"},${request.soleAdmin},${request.decidedByUserId}::uuid,${request.decidedVia},${request.decidedDeviceId}::uuid,${request.approverAuthEpoch}::bigint)`;
  await replaceCodePolicyCoverage(version.id, request.status === "approved" ? manifest.policyRows : [], tx);
  if (request.status === "approved") await recordCodeVersionBaseline(code.id, version.id, tx);
  await audit.record(
    {
      action: `core.code.version.${request.status}`,
      outcome: "allowed",
      actor: { userId: actor.userId },
      target: { type: "code", id: code.id },
      reason: request.soleAdmin ? "self_approved_sole_admin" : null,
      metadata: {
        ...binding,
        event: `version.${request.status}`,
        approvalId: request.id,
        sole_admin: request.soleAdmin,
        soleAdmin: request.soleAdmin,
        decidedVia: request.decidedVia,
      },
    },
    tx,
  );
}
/** Install once per Core replica during lifecycle start; dispose at stop. Decisions fail closed without this owner. */
export const startCodeVersionApprovals = () => registerApprovalDecisionHandler("code_version", applyCodeVersionDecision);

/** Direct CLI/admin decision uses the same C5 policy and transactional handler as shared approval cards and devices. */
export async function decideCodeVersion(raw: CodeVersionBinding, approved: boolean, context: CodeContext): Promise<CodeVersionSubmission> {
  const input = CodeVersionBindingSchema.parse(raw);
  const person = requireCodePolicyAdmin(context, true);
  const submission = await submissionFor(input.codeId, input.versionId, context);
  if (
    input.sourceHash !== submission.binding.sourceHash ||
    input.bundleHash !== submission.binding.bundleHash ||
    input.manifestHash !== submission.binding.manifestHash
  )
    throw new CodeVersionError("code_hash_mismatch", "Decision hashes differ from the submitted version.");
  if (!sameBinding(input, submission.binding))
    throw new CodeVersionError("code_comparison_stale", "Decision comparison differs from the submitted version.");
  if (!submission.approvalId) throw new CodeDataError("CONFLICT", "This version does not have an approval request.");
  const result = await approvals.decide(
    submission.approvalId,
    { approved },
    {
      userId: person.id,
      via: approvalDecisionChannel({ credentialKind: context.authority.credentialKind, actor: context.authority.actor }),
      authority: context.authority,
    },
  );
  if (!result.ok) {
    if (["SELF_APPROVAL", "REAUTHENTICATE", "REJECT_ONLY", "NOT_FOUND"].includes(result.code))
      throw new CodeDataError("FORBIDDEN", `Version decision refused: ${result.code}.`);
    throw new CodeDataError("CONFLICT", `Version decision refused: ${result.code}.`);
  }
  return submissionFor(input.codeId, input.versionId, context);
}
/** C9 calls only after a successful activation, in its Code-locked transaction. Approval uses it too.
 * This records the comparison baseline only; it grants no access, mandate or activation authority.
 */
export async function recordCodeVersionBaseline(codeId: string, versionId: string, tx: SQL): Promise<void> {
  await tx`INSERT INTO code.version_baselines(code_id,version_id) VALUES(${codeId},${versionId}::uuid)
    ON CONFLICT(code_id) DO UPDATE SET version_id=excluded.version_id`;
}
/** Trusted C9/C4 seam. Caller holds policy then Code locks (or one consistent read snapshot).
 * Revalidates immutable evidence, current policy/groups and device/epoch revocation; never creates grants.
 */
export async function requireCodeVersionApproval(code: Code, versionId: string, db: SQL): Promise<{ policyRevision: number }> {
  const version = await versionSnapshot(code.id, versionId, db);
  const manifest = manifestFor(version);
  if (manifest.policyRows.includes("ask_sends"))
    throw new CodeVersionError("code_sends_not_yet", "Unattended sending is available in Phase 3.");
  const [submission] = await db`SELECT version_id FROM code.version_submissions WHERE version_id=${versionId}::uuid`;
  if (!submission) throw new CodeVersionError("code_approval_required", "The version must be submitted first.");
  const policy = await readCodePolicySnapshot(db);
  const membership = await readCodePolicyGroups(code.owner.kind === "person" ? code.owner.userId : version.created_by, db);
  const rows = manifest.policyRows.map((row) => effective(row, code.owner, policy.definition, membership));
  if (rows.some((row) => row.value === "never"))
    throw new CodeVersionError("code_policy_never", "The current Code policy forbids this version.");
  const [decision] = await db<{ approved: boolean; binding: CodeVersionBinding; valid: boolean }[]>`
    SELECT d.approved,d.binding,(u.auth_epoch=d.auth_epoch AND (d.decided_device_id IS NULL OR EXISTS
      (SELECT 1 FROM auth.app_devices device WHERE device.id=d.decided_device_id AND device.user_id=d.decided_by AND device.revoked_at IS NULL))) AS valid
    FROM code.version_decisions d LEFT JOIN auth.users u ON u.id=d.decided_by WHERE d.version_id=${versionId}::uuid`;
  if (decision && (!decision.approved || !decision.valid))
    throw new CodeVersionError("code_approval_revoked", "This version approval is rejected or revoked.");
  if (
    decision &&
    (decision.binding.sourceHash !== version.source_hash ||
      decision.binding.bundleHash !== version.bundle_hash ||
      decision.binding.manifestHash !== approvalArgsDigest(version.manifest))
  )
    throw new CodeVersionError("code_hash_mismatch", "Approval evidence does not match this version.");
  if (rows.some((row) => row.value === "admin") && !decision?.approved)
    throw new CodeVersionError("code_approval_required", "Cloud-admin version approval is required.");
  return { policyRevision: policy.revision };
}
async function requireExecutionEditor(code: Code, context: CodeContext, tx: SQL) {
  const person = codePerson(context, true);
  if (isAppSessionActor(context.authority.actor))
    throw new CodeDataError("FORBIDDEN", "Phone sessions cannot change Code execution authority.");
  if (person.roles.includes("admin") && canRepairAppAccess(context.authority)) requireCodePolicyAdmin(context, true);
  else await requireCodePermission(code, context, true, tx);
  return person;
}
/** Read-only pause/resume preview, naming the exact active version and its future execution effects. */
export async function reviewCodeExecutionChange(
  codeId: string,
  paused: boolean,
  context: CodeContext,
): Promise<CapabilityActionCallReview> {
  await readCode(codeId, context);
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const code = await findCode(codeId, tx);
    if (!code || code.state === "deleting") throw new CodeDataError("NOT_FOUND", "Code not found.");
    await requireExecutionEditor(code, context, tx);
    if (!code.activeVersionId) throw new CodeDataError("CONFLICT", "Activate a version before pausing or resuming it.");
    const version = await versionSnapshot(codeId, code.activeVersionId, tx);
    const approval = paused ? null : await requireCodeVersionApproval(code, code.activeVersionId, tx);
    const { t, locale } = messages(context);
    return {
      locale,
      slots: { code: codeReviewSlot(code) },
      sentence: {
        action: paused ? t.pauseAction : t.resumeAction,
        running: paused ? t.pauseRunning : t.resumeRunning,
        done: paused ? t.pauseDone : t.resumeDone,
        confirm: paused ? t.pauseConfirm : t.resumeConfirm,
        decline: t.cancel,
      },
      ...(paused ? {} : { ask: "keeps_working" as const }),
      consequences: [{ text: paused ? t.pauseEffect : t.resumeEffect }],
      content: {
        kind: "page",
        title: code.title,
        format: "plain",
        body: JSON.stringify({
          codeId,
          activeVersionId: code.activeVersionId,
          sourceHash: version.source_hash,
          bundleHash: version.bundle_hash,
          before: code.state,
          after: paused ? "paused" : "active",
          approval,
        }),
      },
    };
  });
}
/** Pause/resume admissions immediately; events arriving while paused are not replayed. Pending newer versions stay pending. */
export function setCodePaused(codeId: string, paused: true, context: CodeContext): Promise<{ state: "paused" }>;
export function setCodePaused(codeId: string, paused: false, context: CodeContext): Promise<{ state: "active" }>;
export async function setCodePaused(codeId: string, paused: boolean, context: CodeContext) {
  const person = codePerson(context, true);
  if (isAppSessionActor(context.authority.actor))
    throw new CodeDataError("FORBIDDEN", "Phone sessions cannot change Code execution authority.");
  return sql.begin(async (tx) => {
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await tx`SELECT id FROM code.codes WHERE id=${codeId} FOR UPDATE`;
    const code = await findCode(codeId, tx);
    if (!code || code.state === "deleting") throw new CodeDataError("NOT_FOUND", "Code not found.");
    await requireExecutionEditor(code, context, tx);
    if (!code.activeVersionId) throw new CodeDataError("CONFLICT", "Activate a version before pausing or resuming it.");
    if (!paused) await requireCodeVersionApproval(code, code.activeVersionId, tx);
    const state = paused ? ("paused" as const) : ("active" as const);
    if (code.state !== state) {
      await tx`UPDATE code.codes SET state=${state},pause_reason=${paused ? "manual" : null},pause_rows='{}',pause_policy_revision=NULL WHERE id=${codeId}`;
      await audit.record(
        {
          action: paused ? "core.code.paused" : "core.code.resumed",
          outcome: "allowed",
          actor: { userId: person.id },
          target: { type: "code", id: codeId },
          requestId: context.requestId,
          metadata: { versionId: code.activeVersionId },
        },
        tx,
      );
    }
    return { state };
  });
}

/** Use the exact platform snapshot for direct capability approval reviews too. */
export async function reviewCodeVersionDecision(
  input: CodeVersionBinding,
  approved: boolean,
  context: CodeContext,
): Promise<CapabilityActionCallReview> {
  const person = requireCodePolicyAdmin(context, true);
  const submission = await submissionFor(input.codeId, input.versionId, context);
  if (!sameBinding(input, submission.binding) || !submission.approvalId)
    throw new CodeVersionError("code_comparison_stale", "Review does not match the submitted version.");
  const request = await approvals.get(submission.approvalId);
  if (!request?.details || !("sentence" in request.details)) throw new CodeDataError("CONFLICT", "Version review is unavailable.");
  const notice = await codeVersionSoleAdminNotice(request, person.id, context.authority, context.locale);
  const details = notice ? { ...request.details, consequences: [{ text: notice }] } : request.details;
  if (approved) return details;
  const { t, locale } = messages(context);
  const { code } = await readCode(input.codeId, context);
  return {
    ...details,
    slots: { code: codeReviewSlot(code), version: { kind: "text", value: input.versionId } },
    locale,
    sentence: { action: t.rejectAction, running: t.rejectRunning, done: t.rejectDone, confirm: t.decline, decline: t.keepPending },
  };
}
