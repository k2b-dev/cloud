import { sql } from "@k2b/cloud";
import {
  CODE_REQUEST_LIMITS,
  type CodeRouteRequest,
  CodeRouteRequestSchema,
  type CodeRouteResponse,
  CodeRouteResponseSchema,
} from "@k2b/cloud/code";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { CodeDataError } from "./access";
import { codeAdmissionLock } from "./admission";
import { codeSettings } from "./settings";
import { findCode, insertCodeRun } from "./store";
import { requireCodeVersionApproval } from "./versions";

export class CodeRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 413 | 503 | 504,
  ) {
    super(code);
  }
}
/** Admission snapshots the active checked manifest. No visitor credentials or grants enter data dispatch.
 * Every signed-in person may reach non-public routes; handlers restrict access using c.user. */
export async function codeRequestVersion(codeId: string) {
  const [row] = await sql<{ manifest: unknown; active_version_id: string }[]>`SELECT v.manifest,
    c.active_version_id FROM code.codes c
    JOIN code.versions v ON v.id=c.active_version_id
    WHERE c.id=${codeId} AND (c.service_account_id IS NOT NULL OR c.owner_kind='person') AND c.state='active'`;
  const parsed = CodeCheckedVersionManifestSchema.safeParse(row?.manifest);
  if (!row || !parsed.success) throw new CodeRequestError("code_route_not_found", 404);
  return { versionId: row.active_version_id, manifest: parsed.data };
}
/** One bounded request/response job, backed by the normal run lease, mandate and audit trail.
 * No automatic retries: even a disconnected client must never cause an implicit second POST. */
export async function requestCodeRoute(input: {
  codeId: string;
  versionId: string;
  entrypoint: string;
  request: CodeRouteRequest;
  signal: AbortSignal;
}): Promise<CodeRouteResponse> {
  input.signal.throwIfAborted();
  const request = CodeRouteRequestSchema.parse(input.request);
  const started = Date.now();
  const timeoutMs = Math.min(CODE_REQUEST_LIMITS.timeoutMs, await codeSettings.get("core.code.wall_clock_ms"));
  const perCode = await codeSettings.get("core.code.concurrency_per_code");
  const perOwner = await codeSettings.get("core.code.concurrency_per_owner");
  const total = await codeSettings.get("core.code.runner_slots");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]);
  const runId = await sql.begin(async (db) => {
    signal.throwIfAborted();
    await codeAdmissionLock(db);
    await db`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    await db`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
    const code = await findCode(input.codeId, db);
    if (!code || code.state !== "active" || code.activeVersionId !== input.versionId) throw new CodeRequestError("code_route_changed", 409);
    if (code.owner.kind !== "person" && !code.serviceAccountId) throw new CodeRequestError("code_route_account_required", 409);
    await requireCodeVersionApproval(code, input.versionId, db);
    const [counts] = await db<{ own: number; owner: number; requests: number }[]>`SELECT
      count(*) FILTER(WHERE r.code_id=c.id)::int AS own,
      count(*) FILTER(WHERE ROW(o.owner_kind,o.owner_user_id,o.owner_type,o.owner_id,o.owner_app_id)
        IS NOT DISTINCT FROM ROW(c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id))::int AS owner,
      count(*) FILTER(WHERE r.trigger='path')::int AS requests
      FROM code.codes c CROSS JOIN code.runs r JOIN code.codes o ON o.id=r.code_id
      WHERE c.id=${code.id} AND r.state IN('queued','running')`;
    if (counts && (counts.own >= perCode || counts.owner >= perOwner || counts.requests >= total))
      throw new CodeRequestError("code_request_busy", 503);
    signal.throwIfAborted();
    let id: string;
    try {
      id = await insertCodeRun(
        { codeId: code.id, versionId: input.versionId, trigger: "path", entrypoint: input.entrypoint, input: request },
        db,
      );
    } catch (error) {
      if (error instanceof CodeDataError && error.code === "BAD_INPUT") throw new CodeRequestError("code_request_size_limit", 413);
      throw error;
    }
    signal.throwIfAborted();
    await db`UPDATE code.runs SET deadline_at=to_timestamp(${(started + timeoutMs) / 1000}) WHERE id=${id}::uuid`;
    signal.throwIfAborted();
    return id;
  });
  try {
    while (!signal.aborted) {
      const [row] = await sql<{ state: string; output: unknown }[]>`SELECT state,output FROM code.runs WHERE id=${runId}::uuid`;
      if (row?.state === "succeeded") return CodeRouteResponseSchema.parse(row.output);
      if (!row || !["queued", "running"].includes(row.state)) throw new CodeRequestError("code_request_failed", 503);
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 50);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    throw new CodeRequestError("code_request_timeout", 504);
  } finally {
    // Transient visitor input/output never becomes the Code page's retained payload. Calls keep their existing audit contract.
    await sql.begin(async (db) => {
      await db`SELECT id FROM code.runs WHERE id=${runId}::uuid FOR UPDATE`;
      await db`UPDATE code.calls SET state='uncertain',ended_at=clock_timestamp(),result='{"ok":false,"error":{"code":"code_result_unknown"}}'::json
        WHERE run_id=${runId}::uuid AND state='running'`;
      await db`UPDATE code.runs SET outcome=CASE WHEN state IN('queued','running') THEN ${input.signal.aborted ? "code_request_cancelled" : "code_request_timeout"} ELSE outcome END,state=CASE WHEN state IN('queued','running') THEN 'cancelled' ELSE state END,
      ended_at=COALESCE(ended_at,clock_timestamp()),lease_expires_at=NULL,input='null'::jsonb,output=NULL WHERE id=${runId}::uuid`;
    });
  }
}
