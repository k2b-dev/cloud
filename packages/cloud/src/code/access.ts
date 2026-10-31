import type { SQL } from "bun";
import { z } from "zod";
import { capabilityValueDigest } from "../capabilities/calls";
import type { CapabilityDefinitions, CapabilityExecutionContext } from "../contracts/capabilities";
import {
  type CodeAccessAdapter,
  CodeAccessDecisionSchema,
  CodeAccessEntrySchema,
  type CodeAccessGrant,
  CodeAccessGrantSchema,
  type CodeAccessSetData,
  type CodeAccessTarget,
} from "../contracts/code-access";
import { sql } from "../runtime/clients";
import { audit } from "../services/audit";
import { verifyCodeAccessProof } from "./access-proof";

/** Core-mediated person calls only. In particular, personal Code's mandate is still Code origin. */
export const codeAccessPersonAllowed = (context: CapabilityExecutionContext): boolean =>
  context.authority?.credentialKind === "invocation" &&
  context.actor.kind === "user" &&
  context.actor.sessionKind !== "app" &&
  context.actor.delegation?.callingAppId === "core" &&
  context.actor.delegation.credentialKind !== "mandate" &&
  !context.actor.delegation.workloadType &&
  !context.actor.delegation.parentInvocationId &&
  context.accessSubject.type === "user" &&
  context.accessSubject.userId === context.actor.user.id;

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

const decisionNo = (reason: string): CodeAccessSetData => ({ granted: false, reason });
type GrantRow = {
  app_id: string;
  grant_id: string;
  principal: string;
  target_type: string;
  target_id: string;
  binding_hash: string;
  level: string | null;
  revoked: boolean;
};
/** Dependencies are supplied by focused tests; production always uses the platform database/verifier. */
export type CodeAccessDependencies = { db: SQL; verifyProof: typeof verifyCodeAccessProof };
const defaults: CodeAccessDependencies = { db: sql, verifyProof: verifyCodeAccessProof };
const find = async (tx: SQL, appId: string, grantId: string) =>
  (
    await tx<GrantRow[]>`SELECT * FROM capabilities.code_access_grants WHERE app_id = ${appId} AND grant_id = ${grantId}::uuid FOR UPDATE`
  )[0];
const accountIsCode = async (tx: SQL, principal: string) =>
  Boolean(
    (await tx`SELECT id FROM auth.service_accounts WHERE id = ${principal}::uuid AND kind = 'code' AND status = 'active' FOR SHARE`)[0],
  );
const targetAdapter = (bindings: CodeAccessBindings, appId: string, target: CodeAccessTarget) =>
  target.type === "app" && target.id !== appId ? undefined : bindings.get(target.type);
const manages = async (adapter: CodeAccessAdapter, context: CapabilityExecutionContext, id: string) =>
  context.actor.kind === "user" && (context.actor.user.roles.includes("admin") || (await adapter.manages(context, id)));
const writeAudit = (
  tx: SQL,
  appId: string,
  action: string,
  context: CapabilityExecutionContext | { requestId: string },
  grantId: string,
  principal: string,
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
      metadata: { appId, grantId, principal },
    },
    tx,
  );
class RollbackDecision extends Error {
  constructor(readonly data: CodeAccessSetData) {
    super("Code access transaction rolled back");
  }
}

/** Target-side set: proof validation precedes authority, all adapter writes and audit are atomic. */
export const setCodeAccess = async (
  appId: string,
  bindings: CodeAccessBindings,
  input: { proof: string; target: CodeAccessTarget; operations: string[]; dryRun?: boolean },
  context: CapabilityExecutionContext,
  dependencies = defaults,
): Promise<CodeAccessSetData> => {
  if (!codeAccessPersonAllowed(context) || context.actor.kind !== "user")
    return decisionNo("Core person authority required; Code origin is forbidden");
  const claims = await dependencies.verifyProof(input.proof, {
    appId,
    target: input.target,
    operations: input.operations,
    activatingPerson: context.actor.user.id,
  });
  if (!claims) return decisionNo("Invalid or expired Code access proof");
  const adapter = targetAdapter(bindings, appId, input.target);
  if (!adapter) return decisionNo("Target does not support Code access");
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
    return await dependencies.db.begin(async (tx) => {
      // The same transaction lock serializes set/rm for this proof across all app instances.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${appId}:${claims.grantId}`}, 0))`;
      if (!(await accountIsCode(tx, claims.principal))) return decisionNo("An active Code account is required");
      if (!(await manages(adapter, context, input.target.id))) return decisionNo("Target manager authority required");
      const existing = await find(tx, appId, claims.grantId);
      if (existing && (existing.binding_hash !== bindingHash || existing.revoked))
        return decisionNo(
          existing.revoked ? "Code access was removed; activate again to restore it" : "Grant identity is bound to another activation",
        );
      if (existing) {
        const live = z
          .array(CodeAccessEntrySchema)
          .parse(await adapter.list(tx, { principal: claims.principal }))
          .find((entry) => entry.grantId === claims.grantId && entry.id === claims.target.id);
        // Never silently recreate a grant removed at the target, even on a lost-response retry.
        return live
          ? { granted: true, grantId: claims.grantId, level: live.level }
          : decisionNo("Code access was removed; activate again to restore it");
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
      const result: CodeAccessSetData = decision.granted ? { ...decision, grantId: claims.grantId } : decision;
      if (input.dryRun || !decision.granted) throw new RollbackDecision(result);
      await tx`INSERT INTO capabilities.code_access_grants (app_id, grant_id, principal, target_type, target_id, binding_hash, level) VALUES (${appId}, ${claims.grantId}::uuid, ${claims.principal}::uuid, ${input.target.type}, ${input.target.id}, ${bindingHash}, ${decision.level})`;
      await writeAudit(tx, appId, "set", context, claims.grantId, claims.principal, input.target, "allowed");
      return result;
    });
  } catch (error) {
    if (error instanceof RollbackDecision) return error.data;
    throw error;
  }
};

/** Core lists current explicit grants; the target still filters what the person may manage. */
export const listCodeAccess = async (
  appId: string,
  bindings: CodeAccessBindings,
  principal: string,
  context: CapabilityExecutionContext,
  db = sql,
): Promise<CodeAccessGrant[]> => {
  if (!codeAccessPersonAllowed(context)) return [];
  return db.begin(async (tx) => {
    if (!(await accountIsCode(tx, principal))) return [];
    const result: CodeAccessGrant[] = [];
    for (const [type, adapter] of bindings) {
      const entries = z.array(CodeAccessEntrySchema).parse(await adapter.list(tx, { principal }));
      for (const entry of entries) {
        const target = { type, id: entry.id };
        if (targetAdapter(bindings, appId, target) && (await manages(adapter, context, entry.id)))
          result.push(CodeAccessGrantSchema.parse({ grantId: entry.grantId, level: entry.level, target, principal }));
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
  if ("context" in authority && !codeAccessPersonAllowed(authority.context)) return false;
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${appId}:${grantId}`}, 0))`;
    const existing = await find(tx, appId, grantId);
    if (!existing) return false;
    const target = { type: existing.target_type, id: existing.target_id };
    const adapter = targetAdapter(bindings, appId, target);
    if (!adapter) throw new Error(`Code access cleanup requires the declared adapter for ${target.type}`);
    if (
      "cleanupPrincipal" in authority
        ? existing.principal !== authority.cleanupPrincipal
        : !(await manages(adapter, authority.context, target.id))
    )
      return false;
    if (existing.revoked) return true;
    const removed = await adapter.revoke(tx, { id: target.id, grantId });
    if (!removed && (await adapter.list(tx, { principal: existing.principal })).some((entry) => entry.grantId === grantId))
      throw new Error("Code access adapter refused to remove an existing grant");
    // Keep a tombstone: a still-valid activation proof must never restore removed access.
    await tx`UPDATE capabilities.code_access_grants SET revoked = true WHERE app_id = ${appId} AND grant_id = ${grantId}::uuid`;
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
