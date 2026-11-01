import { type CodeAccessGrant, sql } from "@k2b/cloud";
import { readCodeActivationManifest, readResourcePrincipals } from "@k2b/cloud/capabilities/server";
import { type CapabilityManifest, type CodeAccessSetData, CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { isAppSessionActor, type RequestAuthority } from "@k2b/cloud/server";
import { accounts, audit, canRepairAppAccess } from "@k2b/cloud/services";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { isNestedSourceCurrent } from "@k2b/cloud/services/identity";
import { mandates, parseMandatePolicy } from "@k2b/cloud/services/mandates";
import type { SQL } from "bun";
import { z } from "zod";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import {
  type CodeActivation,
  type CodeActivationFailure,
  CodeActivationFailureSchema,
  codeActivationContracts,
} from "./activation-contracts";
import {
  activationTargetSchema,
  buildCodeActivationPlan,
  type CodeActivationTarget,
  ownerTarget,
  targetApp,
  targetKey,
} from "./activation-plan";
import { activationDecision, activationManagerRequired } from "./activation-presentation";
import { type CodeActivationTransport, CodeActivationTransportError, codeActivationTransport } from "./activation-transport";
import type { Code } from "./contracts";
import { findCode } from "./store";
import { CodeVersionError, recordCodeVersionBaseline, requireCodeVersionApproval } from "./versions";

const savedAuthoritySchema = z
  .object({
    userId: z.uuid(),
    scopes: z.array(z.string()),
    proof: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("session"),
          userId: z.uuid(),
          sid: z.uuid(),
          authEpoch: z.number().int().nonnegative(),
          expiresAt: z.iso.datetime(),
        })
        .strict(),
      z.object({ kind: z.literal("oauth"), payload: z.record(z.string(), z.unknown()) }).strict(),
    ]),
  })
  .strict();
type ActivationRow = {
  id: string;
  code_id: string;
  version_id: string;
  activating_person: string | null;
  authority: unknown;
  locale: string;
  cloud_admin: boolean;
  cancel_requested: boolean;
  state: CodeActivation["state"];
  failure: unknown;
  plan: unknown;
  mandate_policy: unknown;
  mandate_id: string | null;
  created_at: Date;
  updated_at: Date;
};
type GrantRow = {
  grant_id: string;
  target: { type: string; id: string };
  operations: string[];
  level: string | null;
  state: string;
  activation_id: string;
};
const receipt = (row: ActivationRow): CodeActivation => ({
  id: row.id,
  codeId: row.code_id,
  versionId: row.version_id,
  state: row.state,
  failure: row.failure === null ? null : CodeActivationFailureSchema.parse(row.failure),
  mandateId: row.mandate_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
async function visibleReceipt(row: ActivationRow, context: CodeContext): Promise<CodeActivation> {
  const result = receipt(row),
    failure = result.failure;
  if (!failure?.target || failure.readable === undefined) return result;
  const person = codePerson(context);
  let readable = false;
  if (failure.readable && failure.target.type !== "app") {
    try {
      const readers = await readResourcePrincipals({
        ref: failure.target,
        principals: [{ type: "user", userId: person.id }],
        locale: context.locale,
      });
      readable =
        readers.state === "checked" && readers.readable.some((principal) => principal.type === "user" && principal.userId === person.id);
    } catch {
      /* An unavailable reader check never supplies presentation. */
    }
  }
  if (!readable)
    result.failure = { target: failure.target, code: failure.code, reason: activationManagerRequired(context.locale), readable: false };
  return result;
}
const load = async (id: string, db: SQL = sql) => (await db<ActivationRow[]>`SELECT * FROM code.activations WHERE id=${id}::uuid`)[0];
const terminal = (state: CodeActivation["state"]) => ["active", "failed", "cancelled"].includes(state);
const lockKey = (codeId: string) => `core.code.activation:${codeId}`;

/** Revocation coordinates, not a session token: current identity and credential ceiling are reloaded for every checkpoint. */
async function restoreAuthority(row: ActivationRow): Promise<CodeContext | null> {
  const parsed = savedAuthoritySchema.safeParse(row.authority);
  if (!parsed.success || row.activating_person !== parsed.data.userId) return null;
  const { userId, scopes, proof } = parsed.data;
  const current = await isNestedSourceCurrent(proof, { sub: userId, credential_kind: proof.kind, principal_type: "user", scopes });
  if (!current) return null;
  const user = await accounts.users.get({ id: userId });
  if (!user || (user.accountExpires && Date.parse(user.accountExpires) <= Date.now())) return null;
  const authority: RequestAuthority = {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId },
    credentialKind: proof.kind,
    scopes,
    credentialProof: proof,
  };
  if (!row.cloud_admin && canRepairAppAccess(authority))
    refuse(null, "authority_changed", "The activating person's authority changed. Start a fresh activation to confirm administrator use.");
  return { authority, locale: row.locale, requestId: row.id };
}
/** Test effects are injected only at Core's network/revocation seams. All durable state still uses Postgres. */
export type CodeActivationDependencies = {
  transport: CodeActivationTransport;
  restoreAuthority: typeof restoreAuthority;
  catalog: typeof readCodeActivationManifest;
};
const defaults: CodeActivationDependencies = { transport: codeActivationTransport, restoreAuthority, catalog: readCodeActivationManifest };

function activationPerson(context: CodeContext) {
  const person = codePerson(context, true),
    { authority } = context;
  if (isAppSessionActor(authority.actor) || authority.actor.kind !== "user" || !["session", "oauth"].includes(authority.credentialKind))
    throw new CodeDataError(
      "FORBIDDEN",
      "Only a browser session or a personal OAuth credential can activate Code; phone sessions cannot activate.",
    );
  return person;
}
async function authorizedCode(codeId: string, context: CodeContext, db: SQL = sql): Promise<Code> {
  const person = activationPerson(context),
    code = await findCode(codeId, db);
  if (!code || code.state === "deleting") throw new CodeDataError("NOT_FOUND", "Code not found.");
  // An editor is not necessarily an owner administrator. Resource owner authority is checked by set(dryRun) on every attempt.
  if (
    code.owner.kind === "person"
      ? code.owner.userId !== person.id
      : !(person.roles.includes("admin") && canRepairAppAccess(context.authority))
  )
    await requireCodePermission(code, context, true, db);
  if (code.owner.kind === "person" && code.owner.userId !== person.id)
    throw new CodeDataError("FORBIDDEN", "Only the personal owner can activate personal Code.");
  return code;
}
/** Enqueue once without waiting on target effects. The unique process identity fences duplicate requests. */
export async function activateCodeVersion(
  raw: z.input<typeof codeActivationContracts.activate.input>,
  context: CodeContext,
): Promise<CodeActivation> {
  const input = codeActivationContracts.activate.input.parse(raw),
    person = activationPerson(context);
  const proof = context.authority.credentialProof;
  if (!proof || proof.kind !== context.authority.credentialKind || proof.kind === "api_key")
    throw new CodeDataError("FORBIDDEN", "Activation needs verified credential revocation coordinates.");
  const authority = savedAuthoritySchema.parse({ userId: person.id, scopes: context.authority.scopes, proof });
  return sql.begin(async (tx) => {
    const existing = await load(input.activationId, tx);
    if (existing) {
      if (existing.code_id !== input.codeId || existing.version_id !== input.versionId || existing.activating_person !== person.id)
        throw new CodeDataError("CONFLICT", "Activation identity belongs to another request.");
      await authorizedCode(input.codeId, context, tx);
      return visibleReceipt(existing, context);
    }
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await tx`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
    const code = await authorizedCode(input.codeId, context, tx);
    await requireCodeVersionApproval(code, input.versionId, tx);
    const created = await tx`INSERT INTO code.activations(id,code_id,version_id,activating_person,authority,locale,cloud_admin)
      VALUES(${input.activationId}::uuid,${code.id},${input.versionId}::uuid,${person.id}::uuid,${JSON.stringify(authority)}::text::jsonb,
        ${context.locale ?? "en"},${person.roles.includes("admin") && canRepairAppAccess(context.authority)}) ON CONFLICT(id) DO NOTHING RETURNING id`;
    if (created.length)
      await audit.record(
        {
          action: "core.code.activation.started",
          outcome: "allowed",
          actor: { userId: person.id },
          target: { type: "code", id: code.id },
          requestId: input.activationId,
          metadata: { versionId: input.versionId },
        },
        tx,
      );
    const inserted = (await load(input.activationId, tx))!;
    if (inserted.code_id !== input.codeId || inserted.version_id !== input.versionId || inserted.activating_person !== person.id)
      throw new CodeDataError("CONFLICT", "Activation identity belongs to another request.");
    await tx`INSERT INTO code.activation_outbox(code_id,activation_id) VALUES(${code.id},${input.activationId}::uuid) ON CONFLICT DO NOTHING`;
    return visibleReceipt((await load(input.activationId, tx))!, context);
  });
}
/** Permission-aware process status for CLI and resource Code pages. */
export async function readCodeActivation(
  input: z.infer<typeof codeActivationContracts.read.input>,
  context: CodeContext,
): Promise<CodeActivation> {
  const code = await findCode(input.codeId);
  if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
  await requireCodePermission(code, context);
  const row = await load(input.activationId);
  if (!row || row.code_id !== code.id) throw new CodeDataError("NOT_FOUND", "Activation not found.");
  return visibleReceipt(row, context);
}
async function state(id: string, value: CodeActivation["state"], failure: CodeActivationFailure | null = null) {
  await sql`UPDATE code.activations SET state=CASE WHEN cancel_requested THEN 'rolling_back' ELSE ${value} END,failure=CASE WHEN cancel_requested THEN failure ELSE ${failure === null ? null : JSON.stringify(failure)}::text::jsonb END,updated_at=now() WHERE id=${id}::uuid`;
}
class ActivationRefused extends Error {
  constructor(readonly failure: CodeActivationFailure) {
    super(failure.code);
  }
}
function refuse(target: CodeActivationFailure["target"], code: string, reason: string): never {
  throw new ActivationRefused({ target, code, reason });
}
function refuseDecision(
  target: CodeActivationFailure["target"],
  raw: Extract<CodeAccessSetData, { granted: false }>,
  context: CodeContext,
): never {
  const decision = activationDecision(raw, context.locale);
  if (decision.granted) throw new Error("Expected refusal");
  throw new ActivationRefused({
    target,
    code: decision.reasonCode,
    reason: decision.reason,
    readable: decision.readable === true,
    ...(decision.readable ? { title: decision.title, managerUserIds: decision.managerUserIds } : {}),
  });
}
async function checkpoint(row: ActivationRow, deps: CodeActivationDependencies): Promise<{ code: Code; context: CodeContext }> {
  if ((await load(row.id))?.cancel_requested) refuse(null, "cancelled", "Activation cancelled.");
  const context = await deps.restoreAuthority(row);
  if (!context) refuse(null, "authority_revoked", "The activating credential has expired or was revoked. Activate again after signing in.");
  const code = await authorizedCode(row.code_id, context!);
  await sql.begin(async (tx) => {
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await requireCodeVersionApproval(code, row.version_id, tx);
  });
  return { code, context: context! };
}
async function liveGrants(code: Code, targets: readonly { target: { type: string; id: string } }[], transport: CodeActivationTransport) {
  const live = new Map<string, CodeAccessGrant>();
  if (code.serviceAccountId)
    for (const app of new Set(targets.map((item) => targetApp(item.target))))
      for (const grant of await transport.list(app, code.serviceAccountId)) live.set(grant.grantId, grant);
  return live;
}
async function prepare(row: ActivationRow, code: Code, deps: CodeActivationDependencies): Promise<CodeActivationTarget[]> {
  const [version] = await sql<
    { manifest: unknown }[]
  >`SELECT manifest FROM code.versions WHERE id=${row.version_id}::uuid AND code_id=${code.id}`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  const catalogs = new Map<string, CapabilityManifest>();
  for (const appId of new Set(manifest.permissions.map((p) => p.operation.split(".")[0]!))) {
    const catalog = await deps.catalog(appId);
    const missingTarget = manifest.permissions.find((p) => p.operation.startsWith(`${appId}.`))?.target;
    if (!catalog)
      refuse(
        missingTarget?.id ? { type: missingTarget.type, id: missingTarget.id } : { type: "app", id: appId },
        "target_unavailable",
        "The target operation catalog is unavailable. Activate again after the application is ready.",
      );
    catalogs.set(appId, catalog);
  }
  const built = buildCodeActivationPlan(code, manifest, catalogs);
  const prior = await sql<
    GrantRow[]
  >`SELECT g.* FROM code.target_grants g JOIN code.version_grants vg ON vg.grant_id=g.grant_id WHERE g.code_id=${code.id} AND g.state='granted' AND vg.version_id=${code.activeVersionId}::uuid ORDER BY g.grant_id`;
  const live = await liveGrants(code, built.targets, deps.transport);
  const plan: CodeActivationTarget[] = [];
  const owner = ownerTarget(code);
  if (owner) plan.push({ target: owner, operations: [], grantId: crypto.randomUUID(), reused: false, owner: true });
  for (const item of built.targets) {
    const reusable = prior.find(
      (grant) =>
        targetKey(grant.target) === targetKey(item.target) &&
        item.operations.every((op) => grant.operations.includes(op)) &&
        live.get(grant.grant_id)?.principal === code.serviceAccountId &&
        live.get(grant.grant_id)?.level === grant.level &&
        targetKey(live.get(grant.grant_id)!.target) === targetKey(item.target),
    );
    plan.push({ ...item, grantId: reusable?.grant_id ?? crypto.randomUUID(), reused: Boolean(reusable), owner: false });
  }
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM code.codes WHERE id=${code.id} FOR UPDATE`;
    if ((await findCode(code.id, tx))?.state === "deleting") refuse(null, "code_unavailable", "Code is being deleted.");
    await tx`UPDATE code.activations SET plan=${JSON.stringify(plan)}::text::jsonb,mandate_policy=${JSON.stringify(built.policy)}::text::jsonb,state=CASE WHEN cancel_requested THEN 'rolling_back' ELSE 'preflight' END,updated_at=now() WHERE id=${row.id}::uuid`;
    for (const item of plan.filter((item) => !item.reused && !item.owner))
      await tx`INSERT INTO code.target_grants(grant_id,code_id,activation_id,target,operations,state)
        VALUES(${item.grantId}::uuid,${code.id},${row.id}::uuid,${JSON.stringify(item.target)}::text::jsonb,${item.operations}::text[],'planned')`;
  });
  return plan;
}
/** Idempotent compensation: every ID belongs to this process, including lost-response attempts. Reused grants are never touched. */
async function rollback(row: ActivationRow, code: Code, deps: CodeActivationDependencies): Promise<void> {
  const owned = await sql<
    GrantRow[]
  >`SELECT * FROM code.target_grants WHERE activation_id=${row.id}::uuid AND state IN ('attempting','granted') ORDER BY grant_id`;
  for (const grant of owned) {
    if (code.serviceAccountId) await deps.transport.remove(targetApp(grant.target), code.serviceAccountId, grant.grant_id);
    await sql`UPDATE code.target_grants SET state='released' WHERE grant_id=${grant.grant_id}::uuid`;
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE code.activations SET state=CASE WHEN failure->>'code'='cancelled' THEN 'cancelled' ELSE 'failed' END,authority=NULL,updated_at=now() WHERE id=${row.id}::uuid`;
    await audit.record(
      {
        action: "core.code.activation.stopped",
        outcome: "allowed",
        actor: row.activating_person ? { userId: row.activating_person } : null,
        target: { type: "code", id: code.id },
        requestId: row.id,
        metadata: {
          versionId: row.version_id,
          failure:
            row.failure === null
              ? null
              : {
                  target: CodeActivationFailureSchema.parse(row.failure).target,
                  code: CodeActivationFailureSchema.parse(row.failure).code,
                },
        },
      },
      tx,
    );
  });
}
/** Worker owns a session advisory lock across separately committed checkpoints; process death releases the lock, never the journal. */
export async function processCodeActivation(activationId: string, overrides?: Partial<CodeActivationDependencies>): Promise<void> {
  const deps = { ...defaults, ...overrides },
    row = await load(activationId);
  if (!row || terminal(row.state)) return;
  const lock = await sql.reserve();
  let acquired = false;
  try {
    const [held] = await lock<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_lock(hashtextextended(${lockKey(row.code_id)},0)) AS acquired`;
    if (!held?.acquired) throw new CodeActivationTransportError("activation_busy", true);
    acquired = true;
    const current = await load(activationId);
    if (!current || terminal(current.state)) return;
    const existingCode = await findCode(row.code_id);
    if (!existingCode) return;
    if (current.state === "rolling_back") {
      await rollback(current, existingCode, deps);
      return;
    }
    let failedTarget: CodeActivationFailure["target"] = null;
    try {
      const { code, context } = await checkpoint(current, deps);
      const plan = current.plan === null ? await prepare(current, code, deps) : z.array(activationTargetSchema).parse(current.plan);
      const notificationManagers = new Map<string, string[]>();
      // Discard prior presentation snapshots before any retry/refusal. Notification audiences are never plan data.
      await sql`UPDATE code.activations SET plan=${JSON.stringify(plan)}::text::jsonb WHERE id=${row.id}::uuid`;
      // Run every preflight before the first write, including after a restart. Owner authority is always checked.
      for (const item of plan.filter((item) => item.owner || !item.reused)) {
        failedTarget = item.target;
        if (!code.serviceAccountId) continue;
        const decision = await deps.transport.set(
          {
            codeId: code.id,
            versionId: row.version_id,
            activationId: row.id,
            activatingPerson: row.activating_person!,
            principal: code.serviceAccountId,
            item,
            dryRun: true,
          },
          context,
        );
        if (!decision.granted) refuseDecision(item.target, decision, context);
        if (current.cloud_admin)
          notificationManagers.set(
            targetKey(item.target),
            await deps.transport.notificationManagers({
              codeId: code.id,
              versionId: row.version_id,
              activationId: row.id,
              activatingPerson: row.activating_person!,
              principal: code.serviceAccountId,
              item,
            }),
          );
      }
      await state(row.id, "applying");
      for (const item of plan.filter((item) => !item.owner && !item.reused)) {
        failedTarget = item.target;
        const checked = await checkpoint(current, deps);
        await sql`UPDATE code.target_grants SET state='attempting' WHERE grant_id=${item.grantId}::uuid AND state='planned'`;
        const decision = await deps.transport.set(
          {
            codeId: code.id,
            versionId: row.version_id,
            activationId: row.id,
            activatingPerson: row.activating_person!,
            principal: code.serviceAccountId!,
            item,
            dryRun: false,
          },
          checked.context,
        );
        if (!decision.granted) refuseDecision(item.target, decision, context);
        if (decision.grantId !== item.grantId) refuse(item.target, "binding_conflict", "The target returned a different grant identity.");
        await sql`UPDATE code.target_grants SET state='granted',level=${decision.level} WHERE grant_id=${item.grantId}::uuid`;
      }
      failedTarget = null;
      const checked = await checkpoint(current, deps);
      const ownerProbe = plan.find((item) => item.owner);
      if (ownerProbe && code.serviceAccountId) {
        const decision = await deps.transport.set(
          {
            codeId: code.id,
            versionId: row.version_id,
            activationId: row.id,
            activatingPerson: row.activating_person!,
            principal: code.serviceAccountId,
            item: ownerProbe,
            dryRun: true,
          },
          checked.context,
        );
        if (!decision.granted) refuseDecision(ownerProbe.target, decision, checked.context);
      }
      const live = await liveGrants(
        code,
        plan.filter((item) => !item.owner),
        deps.transport,
      );
      const recorded = await sql<GrantRow[]>`SELECT * FROM code.target_grants WHERE code_id=${code.id} AND state='granted'`;
      const levels = new Map(recorded.map((grant) => [grant.grant_id, grant.level]));
      for (const item of plan.filter((item) => !item.owner))
        if (
          live.get(item.grantId)?.principal !== code.serviceAccountId ||
          live.get(item.grantId)?.level !== levels.get(item.grantId) ||
          targetKey(live.get(item.grantId)!.target) !== targetKey(item.target)
        )
          refuse(item.target, "removed", "Code access was removed at this target. Activate explicitly again to restore it.");
      await sql.begin(async (tx) => {
        await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
        await tx`SELECT id FROM code.codes WHERE id=${code.id} FOR UPDATE`;
        const locked = await findCode(code.id, tx);
        if (!locked || locked.state === "deleting") refuse(null, "code_unavailable", "Code is being deleted.");
        await requireCodeVersionApproval(locked, row.version_id, tx);
        const [saved] = await tx<ActivationRow[]>`SELECT * FROM code.activations WHERE id=${row.id}::uuid FOR UPDATE`;
        if (!saved || saved.cancel_requested) refuse(null, "cancelled", "Activation cancelled.");
        const [priorMandate] = await tx<
          { id: string }[]
        >`SELECT id FROM auth.mandates WHERE owner_app_id='core' AND workload_type='code.version'
          AND workload_id=${row.version_id} AND state IN ('active','paused') AND confirmed_at IS NOT NULL FOR UPDATE`;
        let mandate = priorMandate ? await mandates.get(priorMandate.id, { db: tx }) : null;
        const subject =
          code.owner.kind === "person"
            ? { type: "user" as const, id: code.owner.userId }
            : { type: "service_account" as const, id: code.serviceAccountId! };
        const policy = parseMandatePolicy(saved.mandate_policy);
        if (
          mandate &&
          (mandate.state !== "active" ||
            (mandate.expiresAt !== null && Date.parse(mandate.expiresAt) <= Date.now()) ||
            mandate.subject.type !== subject.type ||
            mandate.subject.id !== subject.id ||
            approvalArgsDigest(mandate.policy) !== approvalArgsDigest(policy))
        )
          throw new CodeDataError(
            "CONFLICT",
            "The existing version mandate changed or is inactive. Resolve it before activating this version.",
          );
        if (!mandate) {
          const created = await mandates.create(
            {
              authority: { kind: code.owner.kind === "person" ? "interactive" : "admin", userId: row.activating_person! },
              subject,
              ownerAppId: "core",
              workloadType: "code.version",
              workloadId: row.version_id,
              policy,
            },
            { db: tx },
          );
          if (!created.ok) throw new CodeDataError("CONFLICT", created.error.message);
          mandate = created.data;
        }
        await tx`DELETE FROM code.version_grants WHERE version_id=${row.version_id}::uuid`;
        for (const item of plan.filter((item) => !item.owner)) {
          await tx`INSERT INTO code.version_grants(version_id,grant_id) VALUES(${row.version_id}::uuid,${item.grantId}::uuid) ON CONFLICT DO NOTHING`;
        }
        if (saved.cloud_admin)
          for (const item of plan.filter((item) => item.owner || !item.reused))
            for (const userId of new Set(notificationManagers.get(targetKey(item.target)) ?? []))
              await tx`INSERT INTO code.activation_notices(activation_id,target,target_key,user_id)
              SELECT ${row.id}::uuid,${JSON.stringify(item.target)}::text::jsonb,${targetKey(item.target)},id FROM auth.users WHERE id=${userId}::uuid ON CONFLICT DO NOTHING`;
        await recordCodeVersionBaseline(code.id, row.version_id, tx);
        await tx`UPDATE code.codes SET active_version_id=${row.version_id}::uuid,state='active',pause_reason=NULL,pause_rows='{}',pause_policy_revision=NULL WHERE id=${code.id}`;
        await tx`UPDATE code.activations SET state='active',failure=NULL,mandate_id=${mandate.id}::uuid,authority=NULL,updated_at=now() WHERE id=${row.id}::uuid`;
        await tx`INSERT INTO code.activation_outbox(code_id,kind) VALUES(${code.id},'cleanup') ON CONFLICT DO NOTHING`;
        await audit.record(
          {
            action: "core.code.activated",
            outcome: "allowed",
            actor: { userId: row.activating_person! },
            target: { type: "code", id: code.id },
            requestId: row.id,
            metadata: { activationId: row.id, versionId: row.version_id, mandateId: mandate.id, cloudAdmin: saved.cloud_admin },
          },
          tx,
        );
      });
    } catch (error) {
      if (
        error instanceof ActivationRefused ||
        error instanceof CodeDataError ||
        error instanceof CodeVersionError ||
        error instanceof z.ZodError ||
        (error instanceof CodeActivationTransportError && !error.retryable)
      ) {
        const failure =
          error instanceof ActivationRefused
            ? error.failure
            : {
                target: failedTarget,
                code: error instanceof z.ZodError ? "manifest_invalid" : error.code,
                reason: error instanceof z.ZodError ? "Invalid checker evidence." : error.message,
              };
        await state(row.id, "rolling_back", failure);
        await rollback((await load(row.id))!, existingCode, deps);
      } else {
        await state(row.id, "waiting", {
          target: failedTarget,
          code: "activation_retry",
          reason: "Activation is waiting for a dependency. Retry is automatic; the old version stays active.",
        });
        throw error;
      }
    }
  } finally {
    try {
      if (acquired) await lock`SELECT pg_advisory_unlock(hashtextextended(${lockKey(row.code_id)},0))`;
    } finally {
      lock.release();
    }
  }
}
/** Cancellation records intent immediately. The next checkpoint compensates without requiring the old credential. */
export async function cancelCodeActivation(
  input: z.infer<typeof codeActivationContracts.cancel.input>,
  context: CodeContext,
): Promise<CodeActivation> {
  return sql.begin(async (tx) => {
    await authorizedCode(input.codeId, context, tx);
    const [row] = await tx<ActivationRow[]>`SELECT * FROM code.activations WHERE id=${input.activationId}::uuid FOR UPDATE`;
    if (!row || row.code_id !== input.codeId) throw new CodeDataError("NOT_FOUND", "Activation not found.");
    if (!terminal(row.state) && row.state !== "rolling_back") {
      await tx`UPDATE code.activations SET cancel_requested=TRUE,state='rolling_back',failure=${JSON.stringify({ target: null, code: "cancelled", reason: "Activation cancelled." })}::text::jsonb,updated_at=now() WHERE id=${row.id}::uuid`;
      if (!row.cancel_requested)
        await audit.record(
          {
            action: "core.code.activation.cancel_requested",
            outcome: "allowed",
            actor: { userId: activationPerson(context).id },
            target: { type: "code", id: row.code_id },
            requestId: row.id,
            metadata: { versionId: row.version_id },
          },
          tx,
        );
    }
    return visibleReceipt((await load(row.id, tx))!, context);
  });
}
