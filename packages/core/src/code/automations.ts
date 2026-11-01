import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceReaderViewSchema, CodeCheckedVersionManifestSchema, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { z } from "zod";
import type { CodeContext } from "./access";
import { targetApp, targetKey } from "./activation-plan";
import { CODE_ATTENTION_ACCESS_BUDGET_MS, type CodeAttentionReason, cachedCodeAttentionReasons, scanCodeAccess } from "./attention";
import { CodeIdSchema, codeQueryContracts } from "./contracts";
import { codeRunScheduler, codeScheduleId } from "./scheduling-runtime";
import { readCode } from "./store";

const TargetSchema = z
  .object({
    type: z.string(),
    id: z.string(),
    /** The target's name as this person may read it; null otherwise, never guessed. */
    title: z.string().nullable(),
    typeTitle: z.string().nullable(),
  })
  .strict();
export const CodeAutomationSchema = z
  .object({
    entrypoint: z.string(),
    kind: z.enum(["schedule", "manual"]),
    cron: z.string().nullable(),
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
    /** Removed access this automation needs. Only the whole Code can pause, so this is what a row shows instead. */
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
        /** Every target that removed access, also when no automation could be named for it. */
        removedTargets: z.array(TargetSchema),
      })
      .strict(),
  },
} as const;

/** Failed automations whose calls are read to find which one lost access, the same bound as the Code page. */
const MISSING_ACCESS_CHECKS = 3;
/** Calls read per check: a failing call to a removed target is usually among the first. */
const MISSING_ACCESS_CALLS = 10;
/** Removed targets named in one answer; the rest stay IDs. */
const TITLE_LIMIT = 10;
/** Past this, a slow scheduler only leaves the next run out. */
const NEXT_RUN_BUDGET_MS = 1_000;
/** Next runs read in one answer and at once; a version's entrypoints have no fixed limit. */
const NEXT_RUN_LIMIT = 50;
const NEXT_RUN_CONCURRENCY = 8;

type Attributed = { entrypoint: string; lastRunState: string | null; lastRunId: string | null; missing: string[] };

/** The targets one stored call named: its target, else its app, and its additional references. */
const callKeys = (raw: unknown): string[] => {
  const parsed = z
    .object({
      // An app-wide operation stores null: it reaches the app as a whole.
      target: z.object({ type: z.string(), id: z.string() }).nullish(),
      refs: z.record(z.string(), z.object({ type: z.string(), id: z.string() })).optional(),
      capability: z.string().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) return [];
  const appId = parsed.data.capability?.split(".")[0];
  const target = parsed.data.target ?? (appId ? { type: "app", id: appId } : null);
  return [...(target ? [targetKey(target)] : []), ...Object.values(parsed.data.refs ?? {}).map(targetKey)];
};

/**
 * Which automation needs which removed access, by the Code page's rule: a failed last run that called the target names
 * it; the only automation needs it in any case; anything else stays unnamed. Readers get no call contents, so for them
 * only the second rule applies.
 */
export const attributeMissingTargets = async (
  automations: Attributed[],
  removedKeys: ReadonlySet<string>,
  permission: "editor" | "reader",
  readCalls: (runId: string) => Promise<unknown[]>,
): Promise<void> => {
  if (removedKeys.size === 0) return;
  const failed = automations.filter((automation) => automation.lastRunState === "failed" && automation.lastRunId);
  for (const automation of permission === "editor" ? failed.slice(0, MISSING_ACCESS_CHECKS) : []) {
    const calls = await readCalls(automation.lastRunId!).catch(() => []);
    automation.missing = [...new Set(calls.flatMap(callKeys).filter((key) => removedKeys.has(key)))];
  }
  if (automations.length === 1 && automations[0]!.missing.length === 0) automations[0]!.missing = [...removedKeys];
};

/** The target's name through its own app's reader, with this person's authority, and its type's title. */
const targetTitle = async (
  ref: { type: string; id: string },
  context: CodeContext,
): Promise<{ title: string | null; typeTitle: string | null }> => {
  const none = { title: null, typeTitle: null };
  try {
    const appId = targetApp(ref);
    const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority);
    if (!catalog.ok || !catalog.data) return none;
    if (ref.type === "app") return { title: catalog.data.appName, typeTitle: null };
    const reader = resolveCapabilityResourceReader(catalog.data.manifest, ref);
    if (!reader) return none;
    const read = await invokeCapabilityWithDataSchema(
      { appId, capabilityId: reader.localId, kind: "query", input: { id: ref.id } },
      z.object({ view: CloudResourceReaderViewSchema }),
      { authority: context.authority, locale: context.locale, signal: context.signal },
    );
    if (!read.ok) return none;
    const localType = ref.type.slice(appId.length + 1);
    return {
      title: read.data.data.view.title,
      typeTitle: catalog.data.manifest.types.find((type) => type.localId === localType)?.title ?? null,
    };
  } catch {
    return none;
  }
};

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

  // Core's cached attention says whether a target answered "removed"; only then the targets are asked again.
  const reasons = await cachedCodeAttentionReasons(code, context).catch((): CodeAttentionReason[] => []);
  const scanned = reasons.includes("access_missing")
    ? await Promise.race([scanCodeAccess(code, context), Bun.sleep(CODE_ATTENTION_ACCESS_BUDGET_MS).then(() => [])])
    : [];
  const removed = scanned.filter((grant) => grant.state === "removed").map((grant) => grant.target);
  const removedKeys = new Set(removed.map(targetKey));
  const attributed: Attributed[] = manifest.data.entrypoints.map((entry) => ({
    entrypoint: entry.entrypoint,
    lastRunState: lastRun.get(entry.entrypoint)?.state ?? null,
    lastRunId: lastRun.get(entry.entrypoint)?.id ?? null,
    missing: [],
  }));
  await attributeMissingTargets(attributed, removedKeys, permission, (runId) =>
    sql<{ call: unknown }[]>`SELECT call FROM code.calls WHERE run_id=${runId}::uuid ORDER BY ordinal LIMIT ${MISSING_ACCESS_CALLS}`.then(
      (rows) => rows.map((row) => row.call),
    ),
  );
  const unique = [...new Map(removed.map((target) => [targetKey(target), target])).values()];
  const titled = new Map(
    await Promise.all(
      unique.map(
        async (target, index) =>
          [
            targetKey(target),
            { ...target, ...(index < TITLE_LIMIT ? await targetTitle(target, context) : { title: null, typeTitle: null }) },
          ] as const,
      ),
    ),
  );
  const nextRuns = new Map<string, string | null>();
  if (code.state === "active") {
    const scheduled = manifest.data.entrypoints.filter((entry) => entry.kind === "schedule").slice(0, NEXT_RUN_LIMIT);
    for (let start = 0; start < scheduled.length; start += NEXT_RUN_CONCURRENCY)
      await Promise.all(
        scheduled.slice(start, start + NEXT_RUN_CONCURRENCY).map(async (entry) => {
          nextRuns.set(entry.entrypoint, await nextRun(code.id, entry.entrypoint).catch(() => null));
        }),
      );
  }
  const items = manifest.data.entrypoints.map((entry, index): CodeAutomation => {
    const run = lastRun.get(entry.entrypoint);
    return {
      entrypoint: entry.entrypoint,
      kind: entry.kind,
      cron: entry.cron,
      nextRunAt: nextRuns.get(entry.entrypoint) ?? null,
      lastRun: run ? { state: run.state, createdAt: run.created_at.toISOString(), endedAt: run.ended_at?.toISOString() ?? null } : null,
      missingTargets: attributed[index]!.missing.flatMap((key) => titled.get(key) ?? []),
    };
  });
  return { codeId: code.id, items, removedTargets: [...titled.values()] };
}
