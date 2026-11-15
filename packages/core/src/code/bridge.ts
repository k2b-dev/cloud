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
  codeBridgeLocalRefusalKind,
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
import { codeAiReferenceCost, codeAiReservesAttemptBudget, reserveCodeAiBudget, settleCodeAiBudget } from "./ai-budget";
import { codePolicyGroupRowsQuery, codePolicyGroupsFromRows, codePolicySnapshotFromRow, codePolicySnapshotQuery } from "./policy";
import { codePolicyRow, isCodeAiOperation } from "./policy-contracts";
import { effective } from "./policy-effective";
import { codeSettings } from "./settings";
import { appendLockedCodeCall, CodeCallLimitError, CodeReceiptNotCommittedError, type CodeRow, finishCodeCall, mapCode } from "./store";

const CallVersionSchema = z.object({
  version: CodeCheckedVersionManifestSchema.shape.version,
  hashes: CodeCheckedVersionManifestSchema.shape.hashes,
  policyRows: CodeCheckedVersionManifestSchema.shape.policyRows,
  permissions: CodeCheckedVersionManifestSchema.shape.permissions,
  database: CodeCheckedVersionManifestSchema.shape.database,
});

function denied(code: string, status: 200 | 403 | 409 | 503 = 200): never {
  throw new CodeBridgeRefusal(code, status);
}
const refusalResponse = (error: CodeBridgeRefusal) =>
  Response.json({ ok: false, error: { code: error.code, status: error.errorStatus } }, { status: error.status });
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
  const wallMs = await codeSettings.get("core.code.wall_clock_ms");
  // Dependencies enforce the shared policy -> Code -> run lock order. Each locked
  // row supplies its current values even when a concurrent writer made us wait.
  const [entry] = await db<
    (CodeRow & {
      run_code_id: string;
      version_id: string;
      entrypoint: string;
      generation: number;
      valid: boolean;
      payload_bytes: number;
      calls_limit: number;
      wall_valid: boolean;
      trigger: string;
      input: unknown;
      bundle_hash: string | null;
      source_hash: string | null;
      manifest: unknown;
      author_id: string | null;
      entrypoint_valid: boolean | null;
      mandate_owner_app_id: "core" | "runner" | null;
      mandate_valid: boolean | null;
    })[]
  >`
    WITH policy_lock AS MATERIALIZED (
      SELECT singleton FROM code.policy WHERE singleton FOR SHARE
    ), code_lock AS MATERIALIZED (
      SELECT c.* FROM code.codes c CROSS JOIN policy_lock WHERE c.id=${call.claims.codeId} FOR SHARE OF c
    ), run_lock AS MATERIALIZED (
      SELECT r.* FROM code.runs r CROSS JOIN code_lock WHERE r.id=${call.claims.runId}::uuid FOR UPDATE OF r
    )
    SELECT c.*, r.code_id AS run_code_id,r.version_id,r.entrypoint,r.generation,r.trigger,r.input,r.payload_bytes,r.calls_limit,
      (r.state='running' AND r.lease_expires_at>clock_timestamp() AND r.started_at IS NOT NULL
        AND (r.deadline_at IS NULL OR r.deadline_at>clock_timestamp())) AS valid,
      r.started_at + ${wallMs} * interval '1 millisecond' > clock_timestamp() AS wall_valid,
      v.bundle_hash,v.source_hash,v.created_by AS author_id,m.owner_app_id AS mandate_owner_app_id,
      (m.workload_type='code.version' AND m.workload_id=${call.claims.versionId} AND m.revision=${call.claims.mandateRevision}
        AND m.state='active' AND m.confirmed_at IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at>clock_timestamp())
        AND CASE c.owner_kind WHEN 'person' THEN m.subject_kind='user' AND m.subject_user_id=c.owner_user_id
          ELSE m.subject_kind='service_account' AND m.subject_service_account_id=c.service_account_id END) AS mandate_valid,
      jsonb_build_object('version',v.manifest->'version','hashes',v.manifest->'hashes',
        'policyRows',v.manifest->'policyRows','permissions',v.manifest->'permissions',
        'database',COALESCE(v.manifest->'database','false'::jsonb)) AS manifest,
      v.manifest @> ${JSON.stringify({ entrypoints: [{ entrypoint: call.claims.entrypoint }] })}::text::jsonb AS entrypoint_valid
    FROM code_lock c JOIN run_lock r ON true
    LEFT JOIN code.versions v ON v.id=${call.claims.versionId}::uuid AND v.code_id=c.id
    LEFT JOIN auth.mandates m ON m.id=${call.claims.mandateId}::uuid AND m.owner_app_id IN ('core','runner')`;
  if (!entry) denied("runner_lease_lost", 409);
  if (
    !entry.valid ||
    entry.generation !== call.claims.generation ||
    entry.run_code_id !== call.claims.codeId ||
    entry.version_id !== call.claims.versionId ||
    entry.entrypoint !== call.claims.entrypoint ||
    call.claims.exp * 1000 <= Date.now()
  )
    denied("runner_lease_lost", 409);
  const code = mapCode(entry);
  if (code.state !== "active") denied("code_not_active");
  const version = {
    bundle_hash: entry.bundle_hash,
    source_hash: entry.source_hash,
    created_by: entry.author_id,
    manifest: entry.manifest,
    entrypoint_valid: entry.entrypoint_valid,
  };
  if (!version.bundle_hash || version.bundle_hash !== call.claims.bundleHash) denied("code_bundle_mismatch");
  const manifest = CallVersionSchema.safeParse(version.manifest);
  if (
    !manifest.success ||
    manifest.data.hashes.bundle !== version.bundle_hash ||
    manifest.data.hashes.source !== version.source_hash ||
    !version.entrypoint_valid
  )
    denied("code_version_mismatch");
  if (!entry.wall_valid) denied("code_wall_clock_limit");
  return {
    code,
    version,
    manifest: manifest.data,
    run: {
      id: call.claims.runId,
      trigger: entry.trigger,
      input: entry.input,
      payload_bytes: entry.payload_bytes,
      calls_limit: entry.calls_limit,
    },
    mandateOwnerAppId: entry.mandate_owner_app_id,
    mandateValid: entry.mandate_valid,
  };
}

export async function authorizeCodeCall(
  call: CodeBridgeCall,
  db: SQL,
  locked?: Awaited<ReturnType<typeof lockCall>>,
): Promise<"core" | "runner"> {
  const { code, version, manifest } = locked ?? (await lockCall(call, db));
  if (call.kind !== "internet" && call.kind !== "database") requireCodeCapabilityDeclared(call.call, manifest.permissions);
  if (call.kind === "database" && manifest.database !== true) denied("code_db_undeclared", 403);
  const row = call.kind === "database" ? null : codePolicyRow(isCodeAiOperation(call.call.capability) ? "ai" : call.kind, call.policy);
  if (row === "ask_sends" || manifest.policyRows.includes("ask_sends")) denied("code_sends_not_yet");
  if (
    manifest.policyRows.some((row) => row.startsWith("ask_")) ||
    (call.kind === "action" && (!call.policy || !("silent" in call.policy) || call.policy.routines === false))
  )
    denied("code_unattended_forbidden");
  // S2: the ACTUAL call determines this row. A checker permission/row is never authority.
  const [evidence] = await db<
    {
      binding_valid: boolean;
      approved: boolean | null;
      decision_valid: boolean | null;
      decision_binding_valid: boolean | null;
      database: boolean | null;
      policy: { revision: number; preset: string; updated_by: string | null; updated_at: string; rules: unknown };
      memberships: unknown;
      coverage: string[];
    }[]
  >`
    SELECT (SELECT row_to_json(p) FROM (${codePolicySnapshotQuery(db)}) p) AS policy,
      (SELECT COALESCE(jsonb_agg(g),'[]'::jsonb) FROM (${codePolicyGroupRowsQuery(code.owner.kind === "person" ? code.owner.userId : version.created_by, db)}) g) AS memberships,
      ARRAY(SELECT row FROM code.policy_coverage WHERE version_id=${call.claims.versionId}::uuid) AS coverage,
      (s.binding->>'codeId'=${code.id} AND s.binding->>'versionId'=${call.claims.versionId}
      AND s.binding->>'sourceHash'=v.source_hash AND s.binding->>'bundleHash'=v.bundle_hash) AS binding_valid,
      d.approved, d.binding=s.binding AS decision_binding_valid, (s.evidence->>'database')::boolean AS database,
      (u.auth_epoch=d.auth_epoch AND (d.decided_device_id IS NULL OR EXISTS
        (SELECT 1 FROM auth.app_devices device WHERE device.id=d.decided_device_id AND device.user_id=d.decided_by AND device.revoked_at IS NULL))) AS decision_valid
    FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id
    LEFT JOIN code.version_decisions d ON d.version_id=s.version_id LEFT JOIN auth.users u ON u.id=d.decided_by
    WHERE s.version_id=${call.claims.versionId}::uuid AND s.code_id=${code.id}`;
  if (!evidence) denied("code_approval_required");
  const policy = codePolicySnapshotFromRow({ ...evidence.policy, updated_at: new Date(evidence.policy.updated_at) });
  const membership = codePolicyGroupsFromRows(
    z.array(z.object({ id: z.string(), provider: z.string(), ancestor_id: z.string() })).parse(evidence.memberships),
  );
  const value = row ? effective(row, code.owner, policy.definition, membership).value : "automatic";
  if (value === "never") denied("code_policy_never");
  const manifestValues = manifest.policyRows.map((row) => effective(row, code.owner, policy.definition, membership).value);
  if (manifestValues.includes("never")) denied("code_policy_never");
  if (call.kind === "database" && evidence.database !== true) denied("code_db_undeclared", 403);
  if (!evidence.binding_valid) denied("code_hash_mismatch");
  if (evidence.approved !== null) {
    if (!evidence.approved || !evidence.decision_valid) denied("code_approval_revoked");
    if (!evidence.decision_binding_valid) denied("code_hash_mismatch");
  }
  if (manifestValues.includes("admin") && !evidence.approved) denied("code_approval_required");
  // A valid version decision must explicitly cover the classification of this actual call.
  if (row && value === "admin") {
    if (!evidence.approved) denied("code_approval_required");
    if (!evidence.coverage.includes(row)) denied("code_approval_required");
  }
  if (locked) {
    if (!locked.mandateOwnerAppId || !locked.mandateValid) denied("code_mandate_mismatch");
    return locked.mandateOwnerAppId;
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
    receiptAtIssuance = false,
  ): Promise<Response> => {
    // Commit the observation before an external effect. A crash leaves a visible running call, never an unrecorded effect.
    let ordinal: number | undefined;
    let receiptTransactionId: string | undefined;
    let manifest: Awaited<ReturnType<typeof lockCall>>["manifest"] | undefined;
    // The dispatcher's signer transaction owns admission and the durable receipt.
    // It commits before transport. Local/AI/file paths still record up front.
    const deferredReceipt =
      receiptAtIssuance &&
      "capability" in execution &&
      ["query", "action"].includes(call.kind) &&
      !codeAiReservesAttemptBudget(call.call.capability);
    const recordReceipt = async (tx: SQL, locked?: Awaited<ReturnType<typeof lockCall>>) => {
      const current = locked ?? (await lockCall(call, tx));
      const limit = await codeSettings.get("core.code.calls_per_run");
      const payloadLimit = await codeSettings.get("core.code.payload_bytes");
      try {
        const receipt = await appendLockedCodeCall(
          {
            runId: call.claims.runId,
            kind: call.kind === "query" || (call.kind === "database" && call.call.capability === "db.query") ? "query" : "action",
            call: call.call,
            callsLimit: limit,
            payloadLimit,
            effectStarted: call.kind !== "query" && !(call.kind === "database" && call.call.capability === "db.query"),
          },
          current.run,
          tx,
        );
        return { ...receipt, manifest: current.manifest };
      } catch (error) {
        if (error instanceof CodeCallLimitError) denied("code_call_limit");
        if (error instanceof CodeDataError && error.code === "BAD_INPUT") denied("code_input_limit");
        throw error;
      }
    };
    if (!deferredReceipt) ({ ordinal, manifest, receiptTransactionId } = await sql.begin((tx) => recordReceipt(tx)));
    let response: Response;
    let refusalKind: CodeBridgeRefusalKind = "bridge";
    let replayed = false;
    let issuanceRefusal: CodeBridgeRefusal | undefined;
    let aiReservation: string | null = null;
    let aiProfiles: AiModelProfile[] = [];
    let aiFailure: unknown;
    let localFailure: CodeBridgeRefusal | undefined;
    try {
      if (manifest && "capability" in execution && call.kind !== "internet" && call.kind !== "database")
        requireCodeCapabilityDeclared(call.call, manifest.permissions);
      const rate = await (
        options.checkRate ??
        (async (id) => ratelimit({ id: "code-bridge", limit: await codeSettings.get("core.code.calls_per_second") }).check(id))
      )(call.claims.codeId);
      if (rate.limited) denied("code_rate_limited");
      if ("observation" in execution) {
        await sql.begin((tx) => lockCall(call, tx));
        response = await execution.observation();
      } else {
        if (call.kind === "database") await sql.begin((tx) => authorizeCodeCall(call, tx));
        if (codeAiReservesAttemptBudget(call.call.capability)) {
          if (ordinal === undefined) throw new Error("AI receipt missing");
          const aiOrdinal = ordinal;
          aiProfiles = (await readAiSettingsState()).profiles;
          aiReservation = await sql.begin(async (tx) => {
            // Resolve current group policy before reserving; issuance rechecks it before the model is called.
            await authorizeCodeCall(call, tx);
            const reservation = await reserveCodeAiBudget(call.claims, aiOrdinal, await codeSettings.get("core.code.ai_budget_usd"), tx, {
              code: await codeSettings.get("core.code.ai_daily_budget_usd"),
              owner: await codeSettings.get("core.code.ai_owner_daily_budget_usd"),
              timeZone: (await coreSettings.get<string>("app.timezone")) || "UTC",
            });
            if (!reservation.ok) denied(reservation.code);
            return reservation.reserved;
          });
        }
        const fencedIssue: NonNullable<CapabilityDispatchDependencies["withMandateIssueAuthority"]> = async (input, use, options) => {
          const db = options?.db;
          if (!db) denied("code_bridge_unavailable", 503);
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
            if (input.mandateId !== call.claims.mandateId || input.expectedRevision !== call.claims.mandateRevision)
              denied("code_mandate_mismatch");
            if (deferredReceipt) {
              const locked = await lockCall(call, db);
              const receipt = await recordReceipt(db, locked);
              const ownerAppId = await authorizeCodeCall(call, db, locked);
              const result = await mandates.withIssueAuthority(
                { ...input, ownerAppId, codeRun: true },
                async (authority) => {
                  if (
                    authority.workloadType !== "code.version" ||
                    authority.workloadId !== call.claims.versionId ||
                    (locked.code.owner.kind === "person"
                      ? authority.subject.type !== "user" || authority.subject.id !== locked.code.owner.userId
                      : authority.subject.type !== "service_account" || authority.subject.id !== locked.code.serviceAccountId)
                  ) {
                    issuanceRefusal = new CodeBridgeRefusal("code_mandate_mismatch");
                    throw issuanceRefusal;
                  }
                  const event = locked.run.trigger === "event" ? AppEventEnvelopeSchema.parse(locked.run.input) : null;
                  const trigger = event
                    ? { type: event.type, subject: event.subject, ...(event.place ? { place: event.place } : {}) }
                    : null;
                  return use({ ...authority, trigger });
                },
                options,
              );
              // These values are used only after the surrounding signer transaction commits.
              ({ ordinal, manifest, receiptTransactionId } = receipt);
              return result;
            }
            const ownerAppId = await authorizeCodeCall(call, db);
            input = { ...input, ownerAppId, codeRun: true };
          } catch (error) {
            if (error instanceof CodeBridgeRefusal) issuanceRefusal = error;
            throw error;
          }
          const [run] = await db<
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
          onReplay: () => {
            replayed = true;
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
    // Pre-issuance validation/refusal still has a durable observation. A failed
    // signer transaction rolled its receipt back, so verify it before completion.
    if (ordinal === undefined) {
      ({ ordinal, manifest, receiptTransactionId } = await sql.begin((tx) => recordReceipt(tx)));
      // Dispatch can refuse an invalid shape before requesting issuance. Preserve
      // the host's declared-coordinate error and durable refusal in that path too.
      if (deferredReceipt) {
        try {
          requireCodeCapabilityDeclared(call.call, manifest.permissions);
        } catch (error) {
          if (!(error instanceof CodeBridgeRefusal)) throw error;
          refusalKind = codeBridgeLocalRefusalKind(error.code);
          response = refusalResponse(error);
        }
      }
    }
    // Viewer bodies may be bytes or streams. Observe only the outcome; never clone,
    // buffer or persist file contents in the run log.
    const result = RunnerCallResponseSchema.parse(
      "observation" in execution
        ? localFailure
          ? { ok: false, error: { code: localFailure.code, status: localFailure.errorStatus } }
          : response.ok
            ? { ok: true, data: null }
            : { ok: false, error: { code: "code_file_observation_failed", status: response.status >= 400 ? response.status : 503 } }
        : await response.clone().json(),
    );
    if (!result.ok && call.kind === "internet") refusalKind = codeBridgeLocalRefusalKind(result.error.code);
    const success = result.ok;
    const observedOrdinal = ordinal;
    const complete = async (tx: SQL, callOrdinal = observedOrdinal, transactionId = receiptTransactionId) => {
      if (aiReservation !== null)
        await settleCodeAiBudget(
          call.claims,
          callOrdinal,
          issuanceRefusal
            ? "0"
            : codeAiReferenceCost(call.call.capability, aiFailure ? { ok: false, error: aiFailure } : result, aiProfiles, aiReservation),
          tx,
        );
      await finishCodeCall(
        {
          runId: call.claims.runId,
          ordinal: callOrdinal,
          receiptTransactionId: transactionId,
          state: success ? "succeeded" : "failed",
          result,
          replayed,
          confirmedEffect: call.kind === "action" && success && !replayed,
          refusalKind: success ? null : refusalKind,
          endedAt: new Date(),
        },
        tx,
      );
    };
    if (aiReservation !== null) await sql.begin(complete);
    else {
      try {
        await complete(sql);
      } catch (error) {
        if (!(error instanceof CodeReceiptNotCommittedError)) throw error;
        // A signer abort/failed commit invalidated the in-memory ordinal. Record
        // this failure afresh, without touching a different call that reused it.
        const receipt = await sql.begin((tx) => recordReceipt(tx));
        await complete(sql, receipt.ordinal, receipt.receiptTransactionId);
      }
    }
    return response;
  };
  return {
    withCall: (call, execute, options) => runCall(call, { capability: execute }, options?.receipt === "issuance"),
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
