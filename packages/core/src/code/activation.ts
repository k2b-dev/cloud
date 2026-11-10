import { sql } from "@k2b/cloud";
import { type CodeCheckedVersionManifest, CodeCheckedVersionManifestSchema, cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { isAppSessionActor, type RequestAuthority } from "@k2b/cloud/server";
import { accounts, audit, canRepairAppAccess } from "@k2b/cloud/services";
import { isNestedSourceCurrent } from "@k2b/cloud/services/identity";
import { mandates } from "@k2b/cloud/services/mandates";
import { catalogCache, describeTarget } from "@k2b/cloud/ssr/code-page/load";
import { codeActivationRows, codeDynamicOperations } from "@k2b/cloud/ssr/code-page/targets";
import type { SQL } from "bun";
import { z } from "zod";
import { type CodeContext, CodeDataError, codePerson, readCodeOwner, requireCodePermission } from "./access";
import {
  type CodeActivation,
  type CodeActivationFailure,
  CodeActivationFailureSchema,
  type CodeActivationPreview,
  codeActivationContracts,
} from "./activation-contracts";
import type { Code } from "./contracts";
import { requireCodeEventAccess } from "./event-access";
import { syncCodeEventSubscriptions } from "./event-subscriptions";
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
  mandate_id: string | null;
  created_at: Date;
  updated_at: Date;
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
  restoreAuthority: typeof restoreAuthority;
  readOwner: typeof readCodeOwner;
};
const defaults: CodeActivationDependencies = { restoreAuthority, readOwner: readCodeOwner };

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
  return authorizeActivation(codeId, activationPerson(context), context, db);
}
async function authorizeActivation(
  codeId: string,
  person: { id: string; roles: readonly string[] },
  context: CodeContext,
  db: SQL = sql,
): Promise<Code> {
  const code = await findCode(codeId, db);
  if (!code || code.state === "deleting") throw new CodeDataError("NOT_FOUND", "Code not found.");
  // Explicit Code editors may submit source; switching on still checks current owner authority in the worker.
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
const requirePersonalBrowser = (code: Code, context: CodeContext) => {
  if (code.owner.kind === "person" && context.authority.credentialKind !== "session")
    throw new CodeDataError("FORBIDDEN", "Personal Code activation requires its owner's browser session.");
};
const previewAllowed = (context: CodeContext, code: Code): CodeActivationPreview["allowed"] => {
  const { authority } = context;
  if (isAppSessionActor(authority.actor)) return { allowed: false, reason: "phone" };
  if (code.owner.kind === "person" && authority.credentialKind !== "session") return { allowed: false, reason: "credential" };
  return authority.actor.kind === "user" && ["session", "oauth"].includes(authority.credentialKind)
    ? { allowed: true }
    : { allowed: false, reason: "credential" };
};
/** Preview version and approval state without asking any target application about rights. */
export async function previewCodeActivation(
  raw: z.input<typeof codeActivationContracts.preview.input>,
  context: CodeContext,
): Promise<CodeActivationPreview> {
  const input = codeActivationContracts.preview.input.parse(raw);
  const person = codePerson(context, true);
  const code = await authorizeActivation(input.codeId, person, context);
  const [version] = await sql<
    { number: number; manifest: unknown }[]
  >`SELECT number,manifest FROM code.versions WHERE id=${input.versionId}::uuid AND code_id=${code.id}`;
  if (!version) throw new CodeDataError("NOT_FOUND", "Code version not found.");
  const [numbers] = await sql<{ latest: number; running: number | null }[]>`SELECT
      (SELECT max(number) FROM code.versions WHERE code_id=${code.id})::int AS latest,
      (SELECT number FROM code.versions WHERE id=${code.activeVersionId}::uuid)::int AS running`;
  const allowed = previewAllowed(context, code);
  const manifest = CodeCheckedVersionManifestSchema.safeParse(version.manifest);
  const base = {
    codeId: code.id,
    automations: manifest.success
      ? manifest.data.entrypoints.map(({ entrypoint, title, route }) => ({
          entrypoint,
          ...(title === undefined ? {} : { title }),
          ...(route ? { route } : {}),
        }))
      : [],
    title: code.title,
    ownerKind: code.owner.kind,
    versionId: input.versionId,
    number: version.number,
    running: numbers?.running ?? null,
    latest: numbers?.latest ?? version.number,
    allowed,
  };
  const place = null;
  const catalog = catalogCache(context.locale ?? "en");
  const page = await previewPage(code, catalog);
  if (code.activeVersionId === input.versionId) {
    const [activation] = await sql<{ activating_person: string | null; updated_at: Date }[]>`
      SELECT activating_person, updated_at FROM code.activations
      WHERE code_id=${code.id} AND version_id=${input.versionId}::uuid AND state='active' ORDER BY updated_at DESC LIMIT 1`;
    const by = activation?.activating_person ?? null;
    // Activator attribution is local directory data, not a target-manager lookup.
    const [activator] =
      by && by !== person.id && person.roles.includes("user")
        ? await sql<{ name: string }[]>`SELECT COALESCE(NULLIF(trim(display_name),''),
          NULLIF(trim(concat_ws(' ',given_name,sn)),''),uid) AS name FROM auth.users WHERE id=${by}::uuid`.catch(() => [])
        : [];
    const byName = activator?.name ?? null;
    return {
      ...base,
      activated: activation ? { at: activation.updated_at.toISOString(), byYou: by === person.id, byName } : null,
      readiness: { state: "ready" },
      place,
      page,
    };
  }
  // An older card in a chat asks no target again: nothing can be switched on from there.
  if (version.number < base.latest) return { ...base, activated: null, readiness: { state: "ready" }, place, page };
  let readiness: CodeActivationPreview["readiness"] = { state: "ready" };
  try {
    await requireCodeVersionApproval(code, input.versionId, sql);
  } catch (error) {
    if (!(error instanceof CodeVersionError)) throw error;
    readiness =
      error.code === "code_approval_required"
        ? { state: "approval_pending" }
        : { state: "refused", code: error.code, message: error.message };
  }
  const targets = manifest.success ? await previewTargets(code, manifest.data, catalog) : undefined;
  return { ...base, activated: null, readiness, place, page, ...(targets ? { targets } : {}) };
}
/** A resource Code's page from its owner app's registry manifest; the owner app itself is not asked. */
async function previewPage(code: Code, catalog: ReturnType<typeof catalogCache>): Promise<string | null> {
  if (code.owner.kind !== "resource") return null;
  const { ref } = code.owner;
  const app = await catalog(cloudResourceRefAppId(ref));
  const pattern = app?.ok ? app.data?.manifest.code?.pages?.[ref.type.slice(cloudResourceRefAppId(ref).length + 1)] : undefined;
  return pattern ? pattern.replace("{id}", encodeURIComponent(ref.id)) : null;
}
/**
 * The targets the Code page lists for switching on this version, through the same grouping and naming from registry
 * manifests: no target or owner app is asked. The owner row is marked as the Code's own place, unnamed.
 */
async function previewTargets(
  code: Code,
  waiting: CodeCheckedVersionManifest,
  catalog: ReturnType<typeof catalogCache>,
): Promise<NonNullable<CodeActivationPreview["targets"]>> {
  const [active] = code.activeVersionId
    ? await sql<{ manifest: unknown }[]>`SELECT manifest FROM code.versions WHERE id=${code.activeVersionId}::uuid AND code_id=${code.id}`
    : [];
  const activeManifest = active ? CodeCheckedVersionManifestSchema.safeParse(active.manifest) : null;
  const ownerRef = code.owner.kind === "resource" ? code.owner.ref : null;
  const owner = ownerRef ? { ref: ownerRef, title: "" } : { codeId: code.id };
  const running = activeManifest?.success ? activeManifest.data : null;
  const rows = await Promise.all(
    codeActivationRows(running, waiting, ownerRef).map(async (row) => ({
      target: await describeTarget(row.ref, owner, catalog),
      operations: row.operations,
      isNew: row.isNew,
    })),
  );
  const dynamic = codeDynamicOperations(running, waiting);
  return dynamic ? [...rows, { target: null, ...dynamic }] : rows;
}
/** Enqueue once without waiting on owner reads. The unique process identity fences duplicate requests. */
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
  const result = await sql.begin(async (tx) => {
    const existing = await load(input.activationId, tx);
    if (existing) {
      if (existing.code_id !== input.codeId || existing.version_id !== input.versionId || existing.activating_person !== person.id)
        throw new CodeDataError("CONFLICT", "Activation identity belongs to another request.");
      await authorizedCode(input.codeId, context, tx);
      return receipt(existing);
    }
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await tx`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
    const code = await authorizedCode(input.codeId, context, tx);
    requirePersonalBrowser(code, context);
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
    return receipt((await load(input.activationId, tx))!);
  });
  return result;
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
  return receipt(row);
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
async function checkpoint(row: ActivationRow, deps: CodeActivationDependencies): Promise<{ code: Code; context: CodeContext }> {
  if ((await load(row.id))?.cancel_requested) refuse(null, "cancelled", "Activation cancelled.");
  const context = await deps.restoreAuthority(row);
  if (!context) refuse(null, "authority_revoked", "The activating credential has expired or was revoked. Activate again after signing in.");
  const code = await authorizedCode(row.code_id, context!);
  requirePersonalBrowser(code, context!);
  await sql.begin(async (tx) => {
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await requireCodeVersionApproval(code, row.version_id, tx);
  });
  return { code, context: context! };
}
/** A failed switch changes no grants or active version; retain its durable terminal receipt. */
async function rollback(row: ActivationRow, code: Code): Promise<void> {
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
    if (!held?.acquired) throw new Error("activation_busy");
    acquired = true;
    const current = await load(activationId);
    if (!current || terminal(current.state)) return;
    const existingCode = await findCode(row.code_id);
    if (!existingCode) return;
    if (current.state === "rolling_back") {
      await rollback(current, existingCode);
      return;
    }
    try {
      let { code, context } = await checkpoint(current, deps);
      // The owner controls activation; event places must additionally be readable by the executing account.
      if (code.owner.kind !== "person" && !canRepairAppAccess(context.authority)) {
        const owner = await deps.readOwner(code.owner, context);
        if (!owner?.admin) refuse(null, "not_owner_manager", "Only someone who manages the Code owner can switch it on.");
      }
      ({ code, context } = await checkpoint(current, deps));
      await requireCodeEventAccess(code, row.version_id);
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
        >`SELECT id FROM auth.mandates WHERE owner_app_id IN ('core','runner') AND workload_type='code.version'
          AND workload_id=${row.version_id} AND state IN ('active','paused') AND confirmed_at IS NOT NULL FOR UPDATE`;
        let mandate = priorMandate ? await mandates.get(priorMandate.id, { db: tx }) : null;
        const subject =
          code.owner.kind === "person"
            ? { type: "user" as const, id: code.owner.userId }
            : { type: "service_account" as const, id: code.serviceAccountId! };
        if (
          mandate &&
          (mandate.state !== "active" ||
            (mandate.expiresAt !== null && Date.parse(mandate.expiresAt) <= Date.now()) ||
            mandate.subject.type !== subject.type ||
            mandate.subject.id !== subject.id)
        )
          throw new CodeDataError(
            "CONFLICT",
            "The existing version mandate changed or is inactive. Resolve it before activating this version.",
          );
        if (!mandate) {
          const created = await mandates.createPending(
            {
              authority: { kind: code.owner.kind === "person" ? "interactive" : "admin", userId: row.activating_person! },
              subject,
              ownerAppId: "runner",
              workloadType: "code.version",
              workloadId: row.version_id,
              policy: null,
            },
            { db: tx },
          );
          if (!created.ok) throw new CodeDataError("CONFLICT", created.error.message);
          const confirmed = await mandates.confirm(
            {
              mandateId: created.data.id,
              expectedRevision: created.data.revision,
              authority: { kind: "workload", ownerAppId: "runner" },
            },
            { db: tx },
          );
          if (!confirmed.ok) throw new CodeDataError("CONFLICT", confirmed.error.message);
          mandate = confirmed.data;
        }
        // An unconfirmed legacy entry lasts for its current version only. Preserve its
        // policy and pause it in the switch transaction; new entries retain normal drain.
        const pausedLegacy =
          locked.activeVersionId && locked.activeVersionId !== row.version_id
            ? await tx<{ id: string }[]>`UPDATE auth.mandates SET state='paused',revision=revision+1,updated_at=now()
            WHERE owner_app_id IN ('core','runner') AND workload_type='code.version'
              AND workload_id=${locked.activeVersionId} AND policy IS NOT NULL AND state='active' RETURNING id`
            : [];
        await syncCodeEventSubscriptions(locked, row.version_id, tx, mandate);
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
            metadata: {
              activationId: row.id,
              versionId: row.version_id,
              mandateId: mandate.id,
              cloudAdmin: saved.cloud_admin,
              pausedLegacyMandateIds: pausedLegacy.map((entry) => entry.id),
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (
        error instanceof ActivationRefused ||
        error instanceof CodeDataError ||
        error instanceof CodeVersionError ||
        error instanceof z.ZodError
      ) {
        const failure =
          error instanceof ActivationRefused
            ? error.failure
            : {
                target: null,
                code: error instanceof z.ZodError ? "manifest_invalid" : error.code,
                reason: error instanceof z.ZodError ? "Invalid checker evidence." : error.message,
              };
        await state(row.id, "rolling_back", failure);
        await rollback((await load(row.id))!, existingCode);
      } else {
        await state(row.id, "waiting", {
          target: null,
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
/** Cancellation records intent immediately. The next checkpoint ends the attempt without requiring the old credential. */
export async function cancelCodeActivation(
  input: z.infer<typeof codeActivationContracts.cancel.input>,
  context: CodeContext,
): Promise<CodeActivation> {
  const result = await sql.begin(async (tx) => {
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
    return receipt((await load(row.id, tx))!);
  });
  return result;
}
