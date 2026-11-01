import type { SQL } from "bun";
import { z } from "zod";
import { capabilityValueDigest } from "../capabilities/calls";
import { CAPABILITY_MAX_RESULT_BYTES, type CapabilityDefinitions, type CapabilityExecutionContext } from "../contracts/capabilities";
import {
  type CodeAccessAdapter,
  CodeAccessDecisionSchema,
  CodeAccessEntrySchema,
  type CodeAccessGrant,
  CodeAccessGrantSchema,
  type CodeAccessRefusalCode,
  type CodeAccessSetData,
  type CodeAccessTarget,
} from "../contracts/code-access";
import { sql } from "../runtime/clients";
import { hasInstallationAdminInTransaction } from "../services/accounts/users";
import { audit } from "../services/audit";
import { codeAccessMessages } from "../shared/code-access-messages";
import { verifyCodeAccessProof } from "./access-proof";

/** Core-mediated person calls only. In particular, personal Code's mandate is still Code origin. */
export const codeAccessPersonAllowed = (context: CapabilityExecutionContext, operation?: "set" | "list" | "rm"): boolean =>
  context.authority?.credentialKind === "invocation" &&
  context.actor.kind === "user" &&
  context.actor.sessionKind !== "app" &&
  context.actor.delegation?.callingAppId === "core" &&
  ["session", "oauth"].includes(context.actor.delegation.credentialKind) &&
  Boolean(context.actor.delegation.codeAccess) &&
  (!operation || context.actor.delegation.codeAccess === operation) &&
  !context.actor.delegation.workloadType &&
  !context.actor.delegation.parentInvocationId &&
  context.accessSubject.type === "user" &&
  context.accessSubject.userId === context.actor.user.id;

// Even the smallest serialized output row consumes these bytes; derive the work bound
// from the existing public result budget instead of inventing an independent quota.
const minGrantBytes = new TextEncoder().encode(
  JSON.stringify({
    grantId: "0".repeat(36),
    principal: "0".repeat(36),
    target: { type: "app", id: "x" },
    level: "x",
  }),
).byteLength;
const maxListGrants = Math.floor(CAPABILITY_MAX_RESULT_BYTES / minGrantBytes);

export type CodeAccessBindings = ReadonlyMap<string, CodeAccessAdapter>;
export const codeAccessBindings = (appId: string, definitions: CapabilityDefinitions): CodeAccessBindings => {
  const result = new Map<string, CodeAccessAdapter>();
  for (const [type, definition] of Object.entries(definitions.types ?? {})) {
    const access = definition.access;
    if (access?.grant && access.manages && access.revoke && access.list)
      result.set(`${appId}.${type}`, { manages: access.manages, grant: access.grant, revoke: access.revoke, list: access.list });
  }
  if (definitions.code?.access?.app) result.set("app", definitions.code.access.app);
  return result;
};

const decisionNo = (reasonCode: CodeAccessRefusalCode, reason: string): CodeAccessSetData => ({ granted: false, reasonCode, reason });
type GrantRow = {
  app_id: string;
  grant_id: string;
  principal: string;
  target_type: string;
  target_id: string;
  binding_hash: string;
  level: string;
  revoked: boolean;
};
/** Dependencies are supplied by focused tests; production always uses the platform database/verifier. */
export type CodeAccessDependencies = { db: SQL; verifyProof: typeof verifyCodeAccessProof };
const find = async (tx: SQL, appId: string, grantId: string) =>
  (
    await tx<GrantRow[]>`SELECT * FROM capabilities.code_access_grants WHERE app_id = ${appId} AND grant_id = ${grantId}::uuid FOR UPDATE`
  )[0];
const accountIsCode = async (tx: SQL, principal: string, activeOnly = true) =>
  Boolean(
    (
      await tx`SELECT id FROM auth.service_accounts WHERE id = ${principal}::uuid AND kind = 'code' AND (NOT ${activeOnly} OR status = 'active') FOR SHARE`
    )[0],
  );
const targetAdapter = (bindings: CodeAccessBindings, appId: string, target: CodeAccessTarget) =>
  target.type === "app" && target.id !== appId ? undefined : bindings.get(target.type);
const cloudAdminAuthority = async (tx: SQL, context: CapabilityExecutionContext): Promise<boolean> =>
  Boolean(
    context.actor.kind === "user" &&
      context.actor.user.roles.includes("admin") &&
      (context.actor.delegation?.credentialKind === "session" || context.authority?.scopes.includes("admin")) &&
      (await hasInstallationAdminInTransaction(context.actor, tx)),
  );
const manages = async (tx: SQL, adapter: CodeAccessAdapter, context: CapabilityExecutionContext, id: string, admin: boolean) =>
  context.actor.kind === "user" && (admin || (await adapter.manages(tx, context, id)));
const writeAudit = (
  tx: SQL,
  appId: string,
  action: string,
  context: CapabilityExecutionContext | { requestId: string },
  grantId: string | undefined,
  principal: string | undefined,
  target: CodeAccessTarget,
  outcome: "allowed" | "denied",
  reason?: string,
) =>
  audit.record(
    {
      action: `code.access.${action}`,
      outcome,
      actor:
        "actor" in context && context.actor.kind === "user" ? { userId: context.actor.user.id, roles: context.actor.user.roles } : null,
      target,
      requestId: context.requestId,
      reason,
      metadata: { appId, grantId, principal, ...(!("actor" in context) ? { authority: "core_cleanup" } : {}) },
    },
    tx,
  );
class RollbackDecision extends Error {
  constructor(readonly data: CodeAccessSetData) {
    super("Code access transaction rolled back");
  }
}

/** Check the exact generated set envelope before committing any target writes. */
const boundSetResult = (data: CodeAccessSetData, context: CapabilityExecutionContext, dryRun: boolean): CodeAccessSetData => {
  if (!data.granted) return data;
  const copy = codeAccessMessages(context.locale);
  const body = { data, receipt: { text: dryRun ? copy.setAvailable : copy.setDone } };
  return new TextEncoder().encode(JSON.stringify(body)).byteLength <= CAPABILITY_MAX_RESULT_BYTES
    ? data
    : decisionNo("capacity_exceeded", "Target manager list exceeds the Code access response budget");
};

/** Target-side set: proof validation precedes authority, all adapter writes and audit are atomic. */
export const setCodeAccess = async (
  appId: string,
  bindings: CodeAccessBindings,
  input: { proof: string; target: CodeAccessTarget; operations: string[]; dryRun?: boolean },
  context: CapabilityExecutionContext,
  overrides?: CodeAccessDependencies,
  operationsAllowed: () => boolean = () => true,
): Promise<CodeAccessSetData> => {
  const dependencies = overrides ?? { db: sql, verifyProof: verifyCodeAccessProof };
  if (!codeAccessPersonAllowed(context, "set") || context.actor.kind !== "user")
    return decisionNo("origin_forbidden", "Core person authority required; Code origin is forbidden");
  const claims = await dependencies.verifyProof(input.proof, {
    appId,
    target: input.target,
    operations: input.operations,
    activatingPerson: context.actor.user.id,
  });
  const deny = async (reasonCode: CodeAccessRefusalCode, reason: string): Promise<CodeAccessSetData> => {
    if (!input.dryRun)
      await writeAudit(dependencies.db, appId, "set", context, claims?.grantId, claims?.principal, input.target, "denied", reasonCode);
    return decisionNo(reasonCode, reason);
  };
  if (!claims) return deny("proof_invalid", "Invalid or expired Code access proof");
  if (input.operations.length === 0 && !input.dryRun)
    return deny("operations_invalid", "An empty operation set is only valid for an owner dry run");
  if (!operationsAllowed()) return deny("operations_invalid", "Operations do not belong to this target");
  const adapter = targetAdapter(bindings, appId, input.target);
  if (!adapter) return deny("unsupported_target", "Target does not support Code access");
  // Issuance times change on retries; the durable identity and its complete binding do not.
  const bindingHash = capabilityValueDigest({
    codeId: claims.codeId,
    versionId: claims.versionId,
    activationId: claims.activationId,
    activatingPerson: claims.activatingPerson,
    principal: claims.principal,
    grantId: claims.grantId,
    target: claims.target,
    operations: [...claims.operations].sort(),
  });
  try {
    const result = await dependencies.db.begin(async (tx) => {
      // Installation authority locks precede grant/account locks, matching user deletion.
      const admin = await cloudAdminAuthority(tx, context);
      // The same transaction lock serializes set/rm for this proof across all app instances.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${appId}:${claims.grantId}`}, 0))`;
      // Serialize account budget admission as well as individual proof retries.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${appId}:account:${claims.principal}`}, 0))`;
      if (!(await manages(tx, adapter, context, input.target.id, admin)))
        throw new RollbackDecision(decisionNo("not_manager", "Target manager authority required"));
      if (!(await accountIsCode(tx, claims.principal))) return decisionNo("account_inactive", "An active Code account is required");
      const existing = await find(tx, appId, claims.grantId);
      if (existing && (existing.binding_hash !== bindingHash || existing.revoked))
        return decisionNo(
          existing.revoked ? "removed" : "binding_conflict",
          existing.revoked ? "Code access was removed; activate again to restore it" : "Grant identity is bound to another activation",
        );
      if (existing) {
        const live = z
          .array(CodeAccessEntrySchema)
          .parse(await adapter.list(tx, { principal: claims.principal }))
          .find((entry) => entry.grantId === claims.grantId && entry.id === claims.target.id);
        // Never silently recreate a grant removed at the target, even on a lost-response retry.
        const result = live
          ? { granted: true as const, grantId: claims.grantId, level: live.level }
          : decisionNo("removed", "Code access was removed; activate again to restore it");
        if (input.dryRun) {
          if (!live) throw new RollbackDecision(result);
          // A retry still needs the target's current managers for Core notifications.
          const decision = CodeAccessDecisionSchema.parse(
            await adapter.grant(tx, {
              id: input.target.id,
              principal: claims.principal,
              operations: input.operations,
              grantId: claims.grantId,
              dryRun: true,
            }),
          );
          throw new RollbackDecision(
            boundSetResult(
              decision.granted ? { ...decision, grantId: claims.grantId } : { ...decision, reasonCode: "adapter_refused" },
              context,
              true,
            ),
          );
        }
        return result;
      }
      const decision = CodeAccessDecisionSchema.parse(
        await adapter.grant(tx, {
          id: input.target.id,
          principal: claims.principal,
          operations: input.operations,
          grantId: claims.grantId,
          dryRun: input.dryRun === true,
        }),
      );
      const result = boundSetResult(
        decision.granted ? { ...decision, grantId: claims.grantId } : { ...decision, reasonCode: "adapter_refused" },
        context,
        input.dryRun === true,
      );
      if (!decision.granted || !result.granted || (input.dryRun && input.operations.length === 0)) throw new RollbackDecision(result);
      const previous = await tx<
        GrantRow[]
      >`SELECT * FROM capabilities.code_access_grants WHERE app_id = ${appId} AND principal = ${claims.principal}::uuid AND NOT revoked LIMIT ${maxListGrants + 1}`;
      const projected = previous.map((row) => ({
        grantId: row.grant_id,
        principal: row.principal,
        target: { type: row.target_type, id: row.target_id },
        level: row.level,
      }));
      projected.push({ grantId: claims.grantId, principal: claims.principal, target: input.target, level: decision.level });
      if (
        previous.length >= maxListGrants ||
        new TextEncoder().encode(JSON.stringify({ data: projected })).byteLength > CAPABILITY_MAX_RESULT_BYTES
      )
        throw new RollbackDecision(
          decisionNo("capacity_exceeded", "Code account grant list is full; remove unused grants before retrying"),
        );
      if (input.dryRun) throw new RollbackDecision(result);
      await tx`INSERT INTO capabilities.code_access_grants (app_id, grant_id, principal, target_type, target_id, binding_hash, level, live_principal) VALUES (${appId}, ${claims.grantId}::uuid, ${claims.principal}::uuid, ${input.target.type}, ${input.target.id}, ${bindingHash}, ${decision.level}, ${claims.principal}::uuid)`;
      await writeAudit(tx, appId, "set", context, claims.grantId, claims.principal, input.target, "allowed");
      return result;
    });
    if (!result.granted) return deny(result.reasonCode, result.reason);
    return result;
  } catch (error) {
    if (error instanceof RollbackDecision) return error.data.granted ? error.data : deny(error.data.reasonCode, error.data.reason);
    throw error;
  }
};

/** Core inspection sees one account; person invocations see only targets they currently manage. */
export const listCodeAccess = async (
  appId: string,
  bindings: CodeAccessBindings,
  principal: string,
  authority: CapabilityExecutionContext | { listPrincipal: string },
  db = sql,
): Promise<CodeAccessGrant[]> => {
  const coreInspection = "listPrincipal" in authority;
  if (coreInspection ? authority.listPrincipal !== principal : !codeAccessPersonAllowed(authority, "list")) return [];
  return db.begin(async (tx): Promise<CodeAccessGrant[]> => {
    const admin = !coreInspection && (await cloudAdminAuthority(tx, authority));
    if (!(await accountIsCode(tx, principal, false))) return [];
    const indexed = await tx<
      GrantRow[]
    >`SELECT * FROM capabilities.code_access_grants WHERE app_id = ${appId} AND principal = ${principal}::uuid AND NOT revoked LIMIT ${maxListGrants + 1}`;
    if (indexed.length > maxListGrants) throw new Error("Code access list exceeds the capability result budget");
    const indexedById = new Map(indexed.map((entry) => [entry.grant_id, entry]));
    const result: CodeAccessGrant[] = [];
    let bytes = new TextEncoder().encode(JSON.stringify({ data: [] })).byteLength;
    for (const [type, adapter] of bindings) {
      const entries = z
        .array(CodeAccessEntrySchema)
        .max(maxListGrants)
        .parse(await adapter.list(tx, { principal }));
      if (new TextEncoder().encode(JSON.stringify(entries)).byteLength > CAPABILITY_MAX_RESULT_BYTES)
        throw new Error("Code access list exceeds the capability result budget");
      for (const entry of entries) {
        const row = indexedById.get(entry.grantId);
        if (!row || row.target_type !== type || row.target_id !== entry.id) continue;
        const target = { type, id: entry.id };
        if (targetAdapter(bindings, appId, target) && (coreInspection || (await manages(tx, adapter, authority, target.id, admin)))) {
          const grant = CodeAccessGrantSchema.parse({ grantId: entry.grantId, level: entry.level, target, principal });
          bytes += new TextEncoder().encode(JSON.stringify(grant)).byteLength + (result.length ? 1 : 0);
          if (bytes > CAPABILITY_MAX_RESULT_BYTES) throw new Error("Code access list exceeds the capability result budget");
          result.push(grant);
        }
      }
    }
    return result;
  });
};

/**
 * A cleanup call supplies only the principal from a VERIFIED Core cleanup token.
 * It may remove this account's Code grants only; it cannot grant, impersonate a person,
 * remove ordinary shares or remove another account's grants. Missing rows are idempotent.
 */
export const removeCodeAccess = async (
  appId: string,
  bindings: CodeAccessBindings,
  grantId: string,
  authority: { context: CapabilityExecutionContext } | { cleanupPrincipal: string; requestId: string },
  db = sql,
): Promise<boolean> => {
  if ("context" in authority && !codeAccessPersonAllowed(authority.context, "rm")) return false;
  return db.begin(async (tx) => {
    const admin = "context" in authority && (await cloudAdminAuthority(tx, authority.context));
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${appId}:${grantId}`}, 0))`;
    const existing = await find(tx, appId, grantId);
    if (!existing) return false;
    const target = { type: existing.target_type, id: existing.target_id };
    const adapter = targetAdapter(bindings, appId, target);
    if ("context" in authority && (!adapter || !(await manages(tx, adapter, authority.context, target.id, admin)))) return false;
    if (!adapter) throw new Error(`Code access cleanup requires the declared adapter for ${target.type}`);
    if ("cleanupPrincipal" in authority && existing.principal !== authority.cleanupPrincipal) return false;
    if (existing.revoked) return true;
    const removed = await adapter.revoke(tx, { id: target.id, grantId });
    if (!removed && (await adapter.list(tx, { principal: existing.principal })).some((entry) => entry.grantId === grantId))
      throw new Error("Code access adapter refused to remove an existing grant");
    // Keep a tombstone: a still-valid activation proof must never restore removed access.
    await tx`UPDATE capabilities.code_access_grants SET revoked = true, live_principal = NULL WHERE app_id = ${appId} AND grant_id = ${grantId}::uuid`;
    await writeAudit(
      tx,
      appId,
      "rm",
      "context" in authority ? authority.context : authority,
      grantId,
      existing.principal,
      target,
      "allowed",
    );
    return true;
  });
};
