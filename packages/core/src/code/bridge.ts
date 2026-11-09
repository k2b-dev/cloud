import { sql } from "@k2b/cloud";
import { type AiModelProfile, readAiSettingsState } from "@k2b/cloud/ai";
import {
  type CapabilityDispatchDependencies,
  type CodeBridgeAuthority,
  type CodeBridgeCall,
  type CodeBridgeHost,
  CodeBridgeRefusal,
  type CodeBridgeRefusalKind,
  type CodeFileObservationHost,
  type CodeRunnerDispatchDependencies,
  codeBridgeLocalRefusalKind,
  createCodeRunnerCallRoutes,
} from "@k2b/cloud/api";
import { requireCodeCapabilityDeclared } from "@k2b/cloud/code";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { RunnerCallResponseSchema } from "@k2b/cloud/code/runner";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { AppEventEnvelopeSchema } from "@k2b/cloud/events";
import { ratelimit } from "@k2b/cloud/server";
import { coreSettings, mandates } from "@k2b/cloud/services";
import type { SQL } from "bun";
import { z } from "zod";
import { CodeDataError } from "./access";
import { codeAiReferenceCost, reserveCodeAiBudget, settleCodeAiBudget } from "./ai-budget";
import { readCodeOwnOrigins } from "./origins";
import { readCodePolicyGroups, readCodePolicySnapshot } from "./policy";
import { codePolicyRow } from "./policy-contracts";
import { effective } from "./policy-effective";
import { dispatchCodeSecretHttp } from "./secret-http";
import { codeSettings } from "./settings";
import { appendCodeCall, findCode, finishCodeCall } from "./store";

const CallVersionSchema = z.object({
  version: CodeCheckedVersionManifestSchema.shape.version,
  hashes: CodeCheckedVersionManifestSchema.shape.hashes,
  policyRows: CodeCheckedVersionManifestSchema.shape.policyRows,
  permissions: CodeCheckedVersionManifestSchema.shape.permissions,
});

function denied(code: string, status: 200 | 403 | 409 | 503 = 200): never {
  throw new CodeBridgeRefusal(code, status);
}
const refusalResponse = (error: CodeBridgeRefusal) => Response.json({ ok: false, error: { code: error.code } }, { status: error.status });
/** C13 also uses this fence for bundle/heartbeat/completion. No process-local lease or token registry. Lock policy, Code, then run. */
export async function requireCodeRunFence(claims: CodeRunTokenClaims, db: SQL): Promise<void> {
  const [run] = await db<{ code_id: string; version_id: string; entrypoint: string; generation: number; valid: boolean }[]>`
    SELECT code_id,version_id,entrypoint,generation,
      (state='running' AND lease_expires_at>clock_timestamp() AND started_at IS NOT NULL AND (deadline_at IS NULL OR deadline_at>clock_timestamp())) AS valid
    FROM code.runs WHERE id=${claims.runId}::uuid FOR UPDATE`;
  if (
    !run ||
    !run.valid ||
    run.generation !== claims.generation ||
    run.code_id !== claims.codeId ||
    run.version_id !== claims.versionId ||
    run.entrypoint !== claims.entrypoint ||
    claims.exp * 1000 <= Date.now()
  )
    denied("runner_lease_lost", 409);
}
async function lockCall(call: CodeBridgeCall, db: SQL) {
  await db`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
  await db`SELECT id FROM code.codes WHERE id=${call.claims.codeId} FOR SHARE`;
  await requireCodeRunFence(call.claims, db);
  const code = await findCode(call.claims.codeId, db);
  if (!code || code.state !== "active") denied("code_not_active");
  // Old versions may drain while a newly activated version takes new work.
  // Immutable executable data was checked at submission. Read only the small policy/entrypoint projection per call.
  const [version] = await db<
    { bundle_hash: string; source_hash: string; manifest: unknown; created_by: string | null; entrypoint_valid: boolean }[]
  >`
    SELECT bundle_hash,source_hash,created_by,jsonb_build_object(
      'version',manifest->'version','hashes',manifest->'hashes',
      'policyRows',manifest->'policyRows','permissions',manifest->'permissions') AS manifest,
      manifest @> ${JSON.stringify({ entrypoints: [{ entrypoint: call.claims.entrypoint }] })}::text::jsonb AS entrypoint_valid
    FROM code.versions WHERE id=${call.claims.versionId}::uuid AND code_id=${code.id}`;
  if (!version || version.bundle_hash !== call.claims.bundleHash) denied("code_bundle_mismatch");
  const manifest = CallVersionSchema.safeParse(version.manifest);
  if (
    !manifest.success ||
    manifest.data.hashes.bundle !== version.bundle_hash ||
    manifest.data.hashes.source !== version.source_hash ||
    !version.entrypoint_valid
  )
    denied("code_version_mismatch");
  const wallMs = await codeSettings.get("core.code.wall_clock_ms");
  const [budget] = await db<
    { valid: boolean }[]
  >`SELECT started_at + ${wallMs} * interval '1 millisecond' > clock_timestamp() AS valid FROM code.runs WHERE id=${call.claims.runId}::uuid`;
  if (!budget?.valid) denied("code_wall_clock_limit");
  return { code, version, manifest: manifest.data };
}
export async function authorizeCodeCall(call: CodeBridgeCall, db: SQL): Promise<"core" | "runner"> {
  const { code, version, manifest } = await lockCall(call, db);
  if (call.kind !== "internet") requireCodeCapabilityDeclared(call.call, manifest.permissions);
  const row = codePolicyRow(
    call.call.capability.startsWith("core.ai.") && !["core.ai.chat.deliver", "core.ai.chat.run.read"].includes(call.call.capability)
      ? "ai"
      : call.kind,
    call.policy,
  );
  if (row === "ask_sends" || manifest.policyRows.includes("ask_sends")) denied("code_sends_not_yet");
  if (
    manifest.policyRows.some((row) => row.startsWith("ask_")) ||
    (call.kind === "action" && (!call.policy || !("silent" in call.policy) || call.policy.routines === false))
  )
    denied("code_unattended_forbidden");
  // S2: the ACTUAL call determines this row. A checker permission/row is never authority.
  const policy = await readCodePolicySnapshot(db);
  const membership = await readCodePolicyGroups(code.owner.kind === "person" ? code.owner.userId : version.created_by, db);
  const value = effective(row, code.owner, policy.definition, membership).value;
  if (value === "never") denied("code_policy_never");
  const manifestValues = manifest.policyRows.map((row) => effective(row, code.owner, policy.definition, membership).value);
  if (manifestValues.includes("never")) denied("code_policy_never");
  const [evidence] = await db<
    { binding_valid: boolean; approved: boolean | null; decision_valid: boolean | null; decision_binding_valid: boolean | null }[]
  >`
    SELECT (s.binding->>'codeId'=${code.id} AND s.binding->>'versionId'=${call.claims.versionId}
      AND s.binding->>'sourceHash'=v.source_hash AND s.binding->>'bundleHash'=v.bundle_hash) AS binding_valid,
      d.approved, d.binding=s.binding AS decision_binding_valid,
      (u.auth_epoch=d.auth_epoch AND (d.decided_device_id IS NULL OR EXISTS
        (SELECT 1 FROM auth.app_devices device WHERE device.id=d.decided_device_id AND device.user_id=d.decided_by AND device.revoked_at IS NULL))) AS decision_valid
    FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id
    LEFT JOIN code.version_decisions d ON d.version_id=s.version_id LEFT JOIN auth.users u ON u.id=d.decided_by
    WHERE s.version_id=${call.claims.versionId}::uuid AND s.code_id=${code.id}`;
  if (!evidence) denied("code_approval_required");
  if (!evidence.binding_valid) denied("code_hash_mismatch");
  if (evidence.approved !== null) {
    if (!evidence.approved || !evidence.decision_valid) denied("code_approval_revoked");
    if (!evidence.decision_binding_valid) denied("code_hash_mismatch");
  }
  if (manifestValues.includes("admin") && !evidence.approved) denied("code_approval_required");
  // A valid version decision must explicitly cover the classification of this actual call.
  if (value === "admin") {
    if (!evidence.approved) denied("code_approval_required");
    const [coverage] = await db`SELECT row FROM code.policy_coverage WHERE version_id=${call.claims.versionId}::uuid AND row=${row}`;
    if (!coverage) denied("code_approval_required");
  }
  const [mandate] = await db<
    {
      owner_app_id: "core" | "runner";
      revision: number | bigint;
      subject_kind: string;
      subject_user_id: string | null;
      subject_service_account_id: string | null;
    }[]
  >`
    SELECT owner_app_id,revision,subject_kind,subject_user_id,subject_service_account_id FROM auth.mandates
    WHERE id=${call.claims.mandateId}::uuid AND owner_app_id IN ('core','runner') AND workload_type='code.version' AND workload_id=${call.claims.versionId}
    AND state='active' AND confirmed_at IS NOT NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) FOR SHARE`;
  if (
    !mandate ||
    Number(mandate.revision) !== call.claims.mandateRevision ||
    (code.owner.kind === "person"
      ? mandate.subject_kind !== "user" || mandate.subject_user_id !== code.owner.userId
      : mandate.subject_kind !== "service_account" || mandate.subject_service_account_id !== code.serviceAccountId)
  )
    denied("code_mandate_mismatch");
  return mandate.owner_app_id;
}

/** Postgres owns call ordering/budgets; the existing Valkey limiter owns shared admission across Core replicas. */
export function createCodeBridgeHost(
  options: { checkRate?: (codeId: string) => Promise<{ limited: boolean }> } = {},
): CodeBridgeHost & CodeFileObservationHost {
  const runCall = async (
    call: CodeBridgeCall,
    execution: { capability: (authority: CodeBridgeAuthority) => Promise<Response> } | { observation: () => Promise<Response> },
  ): Promise<Response> => {
    // Commit the observation before an external effect. A crash leaves a visible running call, never an unrecorded effect.
    const { ordinal, manifest } = await sql.begin(async (tx) => {
      const { manifest } = await lockCall(call, tx);
      const limit = await codeSettings.get("core.code.calls_per_run");
      const [used] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM code.calls WHERE run_id=${call.claims.runId}::uuid`;
      if ((used?.count ?? 0) >= limit) denied("code_call_limit");
      const [run] = await tx<{ calls_limit: number }[]>`SELECT calls_limit FROM code.runs WHERE id=${call.claims.runId}::uuid`;
      if ((used?.count ?? 0) >= (run?.calls_limit ?? 0)) denied("code_call_limit");
      try {
        const ordinal = await appendCodeCall(
          { runId: call.claims.runId, kind: call.kind === "query" ? "query" : "action", call: call.call },
          tx,
        );
        // Future db/kv/files writes must use an effectful kind too; query is reserved for reads.
        if (call.kind !== "query") await tx`UPDATE code.runs SET effect_started=TRUE WHERE id=${call.claims.runId}::uuid`;
        const payloadLimit = await codeSettings.get("core.code.payload_bytes");
        const [payload] = await tx<
          { valid: boolean }[]
        >`SELECT octet_length(call::text) <= ${payloadLimit} AS valid FROM code.calls WHERE run_id=${call.claims.runId}::uuid AND ordinal=${ordinal}`;
        if (!payload?.valid) denied("code_input_limit");
        return { ordinal, manifest };
      } catch (error) {
        if (error instanceof CodeDataError && error.code === "BAD_INPUT") denied("code_input_limit");
        throw error;
      }
    });
    let response: Response;
    let refusalKind: CodeBridgeRefusalKind = "bridge";
    let issuanceRefusal: CodeBridgeRefusal | undefined;
    let aiReservation: string | null = null;
    let aiProfiles: AiModelProfile[] = [];
    let aiFailure: unknown;
    let localFailure: CodeBridgeRefusal | undefined;
    try {
      if ("capability" in execution && call.kind !== "internet") requireCodeCapabilityDeclared(call.call, manifest.permissions);
      const rate = await (
        options.checkRate ??
        (async (id) => ratelimit({ id: "code-bridge", limit: await codeSettings.get("core.code.calls_per_second") }).check(id))
      )(call.claims.codeId);
      if (rate.limited) denied("code_rate_limited");
      if ("observation" in execution) {
        await sql.begin((tx) => lockCall(call, tx));
        response = await execution.observation();
      } else {
        if (
          call.call.capability.startsWith("core.ai.") &&
          !["core.ai.chat.deliver", "core.ai.chat.run", "core.ai.chat.run.read"].includes(call.call.capability)
        ) {
          aiProfiles = (await readAiSettingsState()).profiles;
          aiReservation = await sql.begin(async (tx) => {
            // Resolve current group policy before reserving; issuance rechecks it before the model is called.
            await authorizeCodeCall(call, tx);
            const reservation = await reserveCodeAiBudget(call.claims, ordinal, await codeSettings.get("core.code.ai_budget_usd"), tx, {
              code: await codeSettings.get("core.code.ai_daily_budget_usd"),
              owner: await codeSettings.get("core.code.ai_owner_daily_budget_usd"),
              timeZone: (await coreSettings.get<string>("app.timezone")) || "UTC",
            });
            if (!reservation.ok) denied(reservation.code);
            return reservation.reserved;
          });
        }
        const fencedIssue: NonNullable<CapabilityDispatchDependencies["withMandateIssueAuthority"]> = async (input, use, options) => {
          if (!options?.db) denied("code_bridge_unavailable", 503);
          try {
            if (call.kind !== "internet") {
              const issued = input.call;
              const sameRef = (a: CodeBridgeCall["call"]["target"], b: CodeBridgeCall["call"]["target"]) =>
                a === null ? b === null : b !== null && a.type === b.type && a.id === b.id;
              if (
                !issued ||
                issued.capability !== call.call.capability ||
                !sameRef(issued.target, call.call.target) ||
                Object.keys(issued.refs).length !== Object.keys(call.call.refs).length ||
                !Object.entries(call.call.refs).every(([key, ref]) => issued.refs[key] && sameRef(ref, issued.refs[key]))
              )
                denied("code_capability_undeclared", 403);
            }
            const ownerAppId = await authorizeCodeCall(call, options.db);
            input = { ...input, ownerAppId, codeRun: true };
            if (input.mandateId !== call.claims.mandateId || input.expectedRevision !== call.claims.mandateRevision)
              denied("code_mandate_mismatch");
          } catch (error) {
            if (error instanceof CodeBridgeRefusal) issuanceRefusal = error;
            throw error;
          }
          const [run] = await options.db<
            { trigger: string; input: unknown }[]
          >`SELECT trigger,input FROM code.runs WHERE id=${call.claims.runId}::uuid`;
          if (!run) denied("runner_lease_lost", 409);
          const event = run.trigger === "event" ? AppEventEnvelopeSchema.parse(run.input) : null;
          const trigger = event ? { type: event.type, subject: event.subject, ...(event.place ? { place: event.place } : {}) } : null;
          return mandates.withIssueAuthority(input, (authority) => use({ ...authority, trigger }), options);
        };
        response = await execution.capability({
          consumeFileRef: (digest) =>
            sql.begin(async (tx) => {
              await authorizeCodeCall(call, tx);
              const rows = await tx`INSERT INTO code.file_redemptions(run_id,digest)
              VALUES(${call.claims.runId}::uuid,${digest}) ON CONFLICT DO NOTHING RETURNING digest`;
              return rows.length === 1;
            }),
          onRefusal: (kind) => {
            refusalKind = kind;
          },
          onFailure: (error) => {
            aiFailure = error;
          },
          mandateId: call.claims.mandateId,
          mandateRevision: call.claims.mandateRevision,
          ownerAppId: "core",
          withMandateIssueAuthority: fencedIssue,
        });
      }
      if (issuanceRefusal) {
        refusalKind = codeBridgeLocalRefusalKind(issuanceRefusal.code);
        response = refusalResponse(issuanceRefusal);
      }
    } catch (error) {
      refusalKind = error instanceof CodeBridgeRefusal ? codeBridgeLocalRefusalKind(error.code) : "bridge";
      localFailure = error instanceof CodeBridgeRefusal ? error : new CodeBridgeRefusal("code_bridge_unavailable", 503);
      response = refusalResponse(localFailure);
    }
    // Viewer bodies may be bytes or streams. Observe only the outcome; never clone,
    // buffer or persist file contents in the run log.
    const result = RunnerCallResponseSchema.parse(
      "observation" in execution
        ? localFailure
          ? { ok: false, error: { code: localFailure.code } }
          : response.ok
            ? { ok: true, data: null }
            : { ok: false, error: { code: "code_file_observation_failed" } }
        : await response.clone().json(),
    );
    if (!result.ok && call.kind === "internet") refusalKind = codeBridgeLocalRefusalKind(result.error.code);
    const success = result.ok;
    await sql.begin(async (tx) => {
      if (aiReservation !== null)
        await settleCodeAiBudget(
          call.claims,
          ordinal,
          issuanceRefusal
            ? "0"
            : codeAiReferenceCost(call.call.capability, aiFailure ? { ok: false, error: aiFailure } : result, aiProfiles, aiReservation),
          tx,
        );
      await finishCodeCall(
        {
          runId: call.claims.runId,
          ordinal,
          state: success ? "succeeded" : "failed",
          result,
          refusalKind: success ? null : refusalKind,
          endedAt: new Date(),
        },
        tx,
      );
    });
    return response;
  };
  return {
    withCall: (call, execute) => runCall(call, { capability: execute }),
    withFileObservation: (observation, execute) => {
      if (!["core.code.file.read", "core.code.file.view"].includes(observation.operation))
        throw new CodeBridgeRefusal("code_capability_undeclared", 403);
      return runCall(
        {
          claims: observation.claims,
          kind: "query",
          call: { capability: observation.operation, target: null, refs: {}, input: observation.input },
        },
        { observation: execute },
      );
    },
  };
}
export { readCodeOwnOrigins } from "./origins";
/** Mount only in Core; C13 adds the other runner protocol endpoints alongside this route. */
export const createCodeBridgeRoutes = (overrides: Partial<CodeRunnerDispatchDependencies> = {}) =>
  createCodeRunnerCallRoutes({ host: createCodeBridgeHost(), ownOrigins: readCodeOwnOrigins, http: dispatchCodeSecretHttp, ...overrides });
