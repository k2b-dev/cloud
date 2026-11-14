import { sql } from "@k2b/cloud";
import { CodeCheckedVersionManifestSchema, type CodeRunReadModel, codeReadModelContracts } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import type { z } from "zod";
import { type CodeContext, CodeDataError } from "../access";
import { codeRunMessages } from "../run-messages";
import { readCode } from "../store";
import { unknownCodeCallOutcomes } from "./call-outcome";
import { codeReadModelMessages } from "./messages";
import { readModelNames } from "./names";
import { describeReadModelTiming, readModelList } from "./present";

type Observation = { operation: string; confirmed: number; replayed: number; refused: number; unknown: number };
export function presentRunObservations(observations: readonly Observation[], locale: string, operation: (id: string) => string) {
  const { t } = codeReadModelMessages.resolve([locale]);
  return observations.flatMap((call) => [
    ...(call.confirmed ? [{ text: t.calls({ action: operation(call.operation), count: call.confirmed }) }] : []),
    ...(call.replayed ? [{ text: t.replayed({ count: call.replayed }) }] : []),
    ...(call.refused ? [{ text: t.refused({ count: call.refused }) }] : []),
    ...(call.unknown ? [{ text: t.unknown({ count: call.unknown }) }] : []),
  ]);
}
export async function loadCodeRunReadModel(
  raw: z.input<typeof codeReadModelContracts.run.input>,
  context: CodeContext,
): Promise<CodeRunReadModel> {
  const input = codeReadModelContracts.run.input.parse(raw);
  const { permission } = await readCode(input.codeId, context);
  const [row] = await sql<
    {
      created_at: Date;
      state: string;
      outcome: string | null;
      entrypoint: string;
      trigger: string;
      manifest: unknown;
      observations: Observation[];
      incomplete: boolean;
    }[]
  >`
    SELECT r.created_at,r.state,r.outcome,r.entrypoint,r.trigger,v.manifest,
      COALESCE((SELECT jsonb_agg(observed ORDER BY operation) FROM (
        SELECT call->>'capability' AS operation,
          count(*) FILTER (WHERE confirmed_effect AND NOT replayed AND state='succeeded')::int AS confirmed,
          count(*) FILTER (WHERE ${permission === "editor"} AND replayed)::int AS replayed,
          count(*) FILTER (WHERE ${permission === "editor"} AND state='failed' AND definite_refusal)::int AS refused,
          count(*) FILTER (WHERE ${permission === "editor"} AND (state IN ('running','uncertain') OR (state='failed' AND NOT definite_refusal) OR (state='succeeded' AND kind='action' AND NOT confirmed_effect AND NOT replayed)))::int AS unknown
        FROM (
          SELECT c.*,COALESCE(refusal_kind IN ('target_refused','policy','approval','app_not_allowed'),FALSE) OR COALESCE(
            CASE WHEN json_typeof(result->'error')='object' THEN (result->'error'->>'status') BETWEEN '400' AND '499'
              ELSE COALESCE(result->>'error',result->>'code') <> ALL(${sql.array([...unknownCodeCallOutcomes], "text")}) END,FALSE) AS definite_refusal
          FROM code.calls c WHERE run_id=r.id
        ) calls GROUP BY call->>'capability'
      ) observed),'[]'::jsonb) AS observations,
      (r.ended_at IS NULL OR EXISTS(SELECT 1 FROM code.calls WHERE run_id=r.id AND state IN ('running','uncertain'))) AS incomplete
    FROM code.runs r JOIN code.versions v ON v.id=r.version_id WHERE r.id=${input.runId}::uuid AND r.code_id=${input.codeId}`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code run not found.");
  const { t, locale } = codeReadModelMessages.resolve(context.locale ? [context.locale] : []);
  const manifest = CodeCheckedVersionManifestSchema.safeParse(row.manifest);
  const names = await readModelNames(
    manifest.success ? [manifest.data] : [],
    context,
    row.observations.map((item) => item.operation),
  );
  const observations = presentRunObservations(row.observations, locale, (operation) => names.operation(operation).title);
  const entry = manifest.success ? manifest.data.entrypoints.find((entry) => entry.entrypoint === row.entrypoint) : undefined;
  const at = row.created_at.toISOString();
  const timeZone = await coreSettings.get<string>("app.timezone");
  const fallback = t.run({
    trigger: row.trigger === "manual" ? t.manual : entry ? describeReadModelTiming(entry, names, locale) : t.schedule,
    at: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(row.created_at),
  });
  const state =
    row.state === "cancelled"
      ? "failed"
      : row.state === "succeeded" || row.state === "failed" || row.state === "skipped" || row.state === "running"
        ? row.state
        : "queued";
  const confirmed = row.observations.find((item) => item.confirmed > 0);
  return {
    runId: input.runId,
    state,
    at,
    title:
      !row.incomplete && confirmed
        ? t.calls({
            action: names.operation(confirmed.operation).title,
            count: confirmed.confirmed,
          })
        : fallback,
    status:
      state === "succeeded"
        ? t.successful
        : state === "failed"
          ? t.failed
          : state === "skipped"
            ? t.skipped
            : state === "running"
              ? t.running
              : t.queued,
    reason: state === "failed" || state === "skipped" ? describeRunFailure(row.outcome, locale) : null,
    untilThen: readModelList(
      [...observations, ...(row.incomplete ? [{ text: t.incomplete }] : !observations.length ? [{ text: t.nothing }] : [])],
      locale,
    ),
    complete: !row.incomplete,
  };
}
export function describeRunFailure(outcome: string | null, locale: string): string {
  const { t } = codeRunMessages.resolve([locale]);
  switch (outcome) {
    case "code_not_active":
    case "code_inactive":
    case "code_version_inactive":
      return t.inactive;
    case "owner_not_found":
      return t.ownerNotFound;
    case "code_admission_refused":
      return t.admissionRefused;
    case "code_mandate_mismatch":
      return t.mandateMismatch;
    case "code_retry_exhausted":
      return t.retryExhausted;
    case "code_run_wall_clock_limit":
      return t.wallClockLimit;
    case "code_run_memory_limit":
      return t.memoryLimit;
    case "code_runner_stalled":
      return t.stalled;
    case "code_result_unknown":
      return t.resultUnknown;
    case "previous_schedule_running":
      return t.previousScheduleRunning;
    case "code_runner_lost":
      return t.lost;
    default:
      return codeReadModelMessages.resolve([locale]).t.runFailed;
  }
}
