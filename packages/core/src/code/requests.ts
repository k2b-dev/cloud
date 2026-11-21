import { sql } from "@k2b/cloud";
import {
  CODE_REQUEST_LIMITS,
  type CodeRouteRequest,
  CodeRouteRequestSchema,
  type CodeRouteResponse,
  CodeRouteResponseSchema,
} from "@k2b/cloud/code";
import {
  CLOUD_RESOURCE_ID_MAX_LENGTH,
  CloudResourceRefSchema,
  type CodeCheckedVersionManifest,
  CodeCheckedVersionManifestSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import { CodeDataError } from "./access";
import { codeAdmissionLock } from "./admission";
import type { CodeOwner } from "./contracts";
import { persistCodeOutput } from "./output";
import { codeSettings } from "./settings";
import { type CodeRow, codeRowOwner, findCode, insertCodeRun } from "./store";
import { requireCodeVersionApproval } from "./versions";

export class CodeRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 413 | 503 | 504,
  ) {
    super(code);
  }
}
/** Who owns the Code a page belongs to, as hosting reads it with the version; a person's name for the label (F26). */
export type CodeRequestOwner = { kind: "person"; userId: string; name: string | null } | Exclude<CodeOwner, { kind: "person" }>;

/** Admission snapshots the active checked manifest. No visitor credentials or grants enter data dispatch.
 * Every signed-in person may reach non-public routes; handlers restrict access using c.user. The same statement
 * reads who owns the Code, so the page's label costs no statement of its own. */
export async function codeRequestVersion(
  codeId: string,
): Promise<{ versionId: string; manifest: CodeCheckedVersionManifest; owner: CodeRequestOwner }> {
  const [row] = await sql<
    (Pick<CodeRow, "owner_kind" | "owner_user_id" | "owner_type" | "owner_id" | "owner_app_id"> & {
      manifest: unknown;
      active_version_id: string;
      owner_name: string | null;
    })[]
  >`SELECT v.manifest,c.active_version_id,c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id,
    COALESCE(NULLIF(u.display_name,''),u.uid) AS owner_name FROM code.codes c
    JOIN code.versions v ON v.id=c.active_version_id
    LEFT JOIN auth.users u ON u.id=c.owner_user_id
    WHERE c.id=${codeId} AND (c.service_account_id IS NOT NULL OR c.owner_kind='person') AND c.state='active'`;
  const parsed = CodeCheckedVersionManifestSchema.safeParse(row?.manifest);
  const owner = row && codeRowOwner(row);
  if (!row || !parsed.success || !owner) throw new CodeRequestError("code_route_not_found", 404);
  return {
    versionId: row.active_version_id,
    manifest: parsed.data,
    owner: owner.kind === "person" ? { ...owner, name: row.owner_name } : owner,
  };
}
/**
 * One read of a finished route run (G1): the target or a ref of a succeeded Query, the short string input fields of a
 * succeeded app-wide Query (hosting keeps those that name a resource: a type reader's `id`, declared `inputRefs`), and
 * each succeeded Query itself, which a public route may call only with owner-data.
 */
export type CodeRouteRead =
  | { kind: "target"; ref: { type: string; id: string } }
  /** Top-level string input fields of an app-wide Query; hosting keeps those that name a resource (`inputRefs`). */
  | { kind: "input"; capability: string; fields: Readonly<Record<string, string>> }
  | { kind: "query"; capability: string };
/** The route's answer and what it read on the way; hosting checks the reads for the visitor before it delivers. */
export type CodeRouteAnswer = CodeRouteResponse & { reads: readonly CodeRouteRead[] };

/**
 * G1: what a run read, as one subquery for a larger statement. Only succeeded Queries can have put data into the answer:
 * their target, each ref, the string input fields of an app-wide Query, cut one character past the longest resource ID
 * (so a longer value stays visible as unusable), and the Query itself.
 * Actions are writes and stay outside; the run's call budget bounds the rows.
 */
export const codeRunReadsQuery = (runId: string) => sql`SELECT COALESCE(jsonb_agg(DISTINCT x.read),'[]'::jsonb) FROM code.calls c
  CROSS JOIN LATERAL (
    SELECT jsonb_build_object('kind','target','ref',c.call->'target') AS read WHERE jsonb_typeof(c.call->'target')='object'
    UNION ALL SELECT jsonb_build_object('kind','target','ref',ref.value) FROM jsonb_each(
      CASE WHEN jsonb_typeof(c.call->'refs')='object' THEN c.call->'refs' ELSE '{}'::jsonb END) ref
    UNION ALL SELECT jsonb_build_object('kind','input','capability',c.call->>'capability','fields',f.fields)
      FROM (SELECT jsonb_object_agg(e.key,to_jsonb(left(e.value#>>'{}',${CLOUD_RESOURCE_ID_MAX_LENGTH + 1}))) AS fields FROM jsonb_each(
        CASE WHEN jsonb_typeof(c.call->'input')='object' THEN c.call->'input' ELSE '{}'::jsonb END) e
        WHERE jsonb_typeof(e.value)='string') f
      WHERE jsonb_typeof(c.call->'target')='null' AND f.fields IS NOT NULL
    UNION ALL SELECT jsonb_build_object('kind','query','capability',c.call->>'capability')
  ) x
  WHERE c.run_id=${runId}::uuid AND c.kind='query' AND c.state='succeeded'`;
export const parseCodeRouteReads = (value: unknown): CodeRouteRead[] => CodeRouteReadsSchema.parse(value ?? []);

const CodeRouteReadsSchema = z.array(
  z.union([
    z.object({ kind: z.literal("target"), ref: CloudResourceRefSchema }),
    z.object({ kind: z.literal("input"), capability: z.string().min(1), fields: z.record(z.string(), z.string()) }),
    z.object({ kind: z.literal("query"), capability: z.string().min(1) }),
  ]),
);

/** One bounded request/response job, backed by the normal run lease, mandate and audit trail.
 * No automatic retries: even a disconnected client must never cause an implicit second POST. */
export async function requestCodeRoute(input: {
  codeId: string;
  versionId: string;
  entrypoint: string;
  request: CodeRouteRequest;
  signal: AbortSignal;
}): Promise<CodeRouteAnswer> {
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
      // The same statement reads what the run read once it succeeded (G1), so the check costs no statement of its own.
      const [row] = await sql<{ state: string; output: unknown; reads: unknown }[]>`SELECT r.state,r.output,
        CASE WHEN r.state='succeeded' THEN (${codeRunReadsQuery(runId)}) END AS reads
        FROM code.runs r WHERE r.id=${runId}::uuid`;
      if (row?.state === "succeeded") return { ...CodeRouteResponseSchema.parse(row.output), reads: parseCodeRouteReads(row.reads) };
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
      const [run] = await db<
        { generation: number; console_output: unknown }[]
      >`SELECT generation,console_output FROM code.runs WHERE id=${runId}::uuid FOR UPDATE`;
      if (run && run.console_output === null) await persistCodeOutput(runId, db, run.generation);
      await db`UPDATE code.calls SET state='uncertain',ended_at=clock_timestamp(),result='{"ok":false,"error":{"code":"code_result_unknown"}}'::json
        WHERE run_id=${runId}::uuid AND state='running'`;
      await db`UPDATE code.runs SET outcome=CASE WHEN state IN('queued','running') THEN ${input.signal.aborted ? "code_request_cancelled" : "code_request_timeout"} ELSE outcome END,state=CASE WHEN state IN('queued','running') THEN 'cancelled' ELSE state END,
      ended_at=COALESCE(ended_at,clock_timestamp()),lease_expires_at=NULL,input='null'::jsonb,output=NULL WHERE id=${runId}::uuid`;
    });
  }
}
