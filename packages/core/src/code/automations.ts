import { sql } from "@k2b/cloud";
import { CodeAutomationTitleSchema, CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { coreSettings } from "@k2b/cloud/services";
import { z } from "zod";
import type { CodeContext } from "./access";
import { CodeIdSchema, codeQueryContracts } from "./contracts";
import { codeScheduleRequestKey } from "./scheduling";
import { CODE_SCHEDULE_TICK_RETENTION_MS } from "./scheduling-contracts";
import { codeRunScheduler, codeScheduleId } from "./scheduling-runtime";
import { readCode } from "./store";

const TargetSchema = z
  .object({
    type: z.string(),
    id: z.string(),
    /** Stored target title when available; currently null, with no target-app lookup. */
    title: z.string().nullable(),
    typeTitle: z.string().nullable(),
  })
  .strict();
export const CodeAutomationSchema = z
  .object({
    entrypoint: z.string(),
    title: CodeAutomationTitleSchema.optional(),
    kind: z.enum(["schedule", "manual", "event", "route"]),
    cron: z.string().nullable(),
    at: z.iso.datetime({ offset: true }).optional(),
    timeZone: z.string().optional(),
    /** When the installation's scheduler runs it next; null when it does not or the scheduler cannot say. */
    nextRunAt: z.iso.datetime().nullable(),
    /** Its newest run that did something; skipped ticks and cancelled starts are not results. */
    lastRun: z
      .object({
        state: z.enum(["queued", "running", "succeeded", "failed"]),
        createdAt: z.iso.datetime(),
        endedAt: z.iso.datetime().nullable(),
      })
      .strict()
      .nullable(),
    /** Targets that refused a call in this automation’s latest run; this is historical evidence, not a current rights inventory. */
    missingTargets: z.array(TargetSchema),
  })
  .strict();
export type CodeAutomation = z.infer<typeof CodeAutomationSchema>;

export const codeAutomationContracts = {
  list: {
    input: codeQueryContracts.read.input,
    data: z
      .object({
        codeId: CodeIdSchema,
        /** The running version's automations; empty when no version runs. */
        items: z.array(CodeAutomationSchema),
        /** Targets that refused a call in the latest finished runs, also when no automation could be named. */
        removedTargets: z.array(TargetSchema),
      })
      .strict(),
  },
} as const;

/** Past this, a slow scheduler only leaves the next run out. */
const NEXT_RUN_BUDGET_MS = 1_000;
/** Next runs read in one answer and at once; a version's entrypoints have no fixed limit. */
const NEXT_RUN_LIMIT = 50;
const NEXT_RUN_CONCURRENCY = 8;

const schedulerNextRun = async (codeId: string, entrypoint: string): Promise<string | null> => {
  const info = await Promise.race([
    codeRunScheduler().get({ id: codeScheduleId(codeId, entrypoint) }),
    Bun.sleep(NEXT_RUN_BUDGET_MS).then(() => null),
  ]);
  return info ? info.nextRunAt.toISOString() : null;
};

/**
 * One Code's automations as a list row shows them. Every part that cannot be read leaves only that part out: the list
 * of automations itself comes from the immutable running version.
 */
export async function listCodeAutomations(
  input: z.infer<typeof codeAutomationContracts.list.input>,
  context: CodeContext,
  nextRun: (codeId: string, entrypoint: string) => Promise<string | null> = schedulerNextRun,
): Promise<z.infer<typeof codeAutomationContracts.list.data>> {
  const { code, permission } = await readCode(input.codeId, context);
  const none = { codeId: code.id, items: [], removedTargets: [] };
  if (!code.activeVersionId || code.state === "deleting") return none;
  const [version] = await sql<
    { manifest: unknown }[]
  >`SELECT manifest FROM code.versions WHERE id=${code.activeVersionId}::uuid AND code_id=${code.id}`;
  const manifest = CodeCheckedVersionManifestSchema.safeParse(version?.manifest);
  if (!manifest.success) return none;
  const runs = await sql<
    { id: string; entrypoint: string; state: "queued" | "running" | "succeeded" | "failed"; created_at: Date; ended_at: Date | null }[]
  >`
    SELECT DISTINCT ON (entrypoint) id, entrypoint, state, created_at, ended_at FROM code.runs
    WHERE code_id=${code.id} AND state NOT IN ('skipped','cancelled') ORDER BY entrypoint, created_at DESC`;
  const lastRun = new Map(runs.map((run) => [run.entrypoint, run]));

  const refused =
    permission === "editor"
      ? await sql<{ run_id: string; target: { type: string; id: string } }[]>`
    SELECT r.id AS run_id, c.call->'target' AS target FROM code.runs r
      JOIN code.calls c ON c.run_id=r.id AND c.ordinal=r.first_refused_call_ordinal
    WHERE r.id=ANY(${sql.array(
      runs.filter((run) => run.state === "failed").map((run) => run.id),
      "uuid",
    )}::uuid[])
      AND c.refusal_kind='target_refused' AND c.call->'target' IS NOT NULL AND c.call->'target'<>'null'::jsonb`
      : [];
  const targetForRun = new Map(refused.map((row) => [row.run_id, { ...row.target, title: null, typeTitle: null }]));
  const nextRuns = new Map<string, string | null>();
  if (code.state === "active") {
    const scheduled = manifest.data.entrypoints.filter((entry) => entry.kind === "schedule").slice(0, NEXT_RUN_LIMIT);
    for (let start = 0; start < scheduled.length; start += NEXT_RUN_CONCURRENCY)
      await Promise.all(
        scheduled.slice(start, start + NEXT_RUN_CONCURRENCY).map(async (entry) => {
          if (entry.at) {
            const [consumed] = await sql`SELECT 1 FROM code.run_requests WHERE code_id=${code.id}
              AND request_key=${codeScheduleRequestKey(entry.entrypoint, new Date(entry.at))}`;
            nextRuns.set(
              entry.entrypoint,
              consumed || new Date(entry.at).getTime() <= Date.now() - CODE_SCHEDULE_TICK_RETENTION_MS
                ? null
                : new Date(entry.at).toISOString(),
            );
          } else nextRuns.set(entry.entrypoint, await nextRun(code.id, entry.entrypoint).catch(() => null));
        }),
      );
  }
  const defaultTimeZone = await coreSettings.get<string>("app.timezone");
  const items = manifest.data.entrypoints.map((entry): CodeAutomation => {
    const run = lastRun.get(entry.entrypoint);
    return {
      entrypoint: entry.entrypoint,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      kind: entry.kind,
      cron: entry.cron,
      ...(entry.at === undefined ? {} : { at: entry.at }),
      ...(entry.kind === "schedule" ? { timeZone: entry.timeZone ?? defaultTimeZone } : {}),
      nextRunAt: nextRuns.get(entry.entrypoint) ?? null,
      lastRun: run ? { state: run.state, createdAt: run.created_at.toISOString(), endedAt: run.ended_at?.toISOString() ?? null } : null,
      missingTargets: run && targetForRun.has(run.id) ? [targetForRun.get(run.id)!] : [],
    };
  });
  return {
    codeId: code.id,
    items,
    removedTargets: [...new Map([...targetForRun.values()].map((target) => [JSON.stringify(target), target])).values()],
  };
}
