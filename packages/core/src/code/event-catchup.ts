import { setTimeout as delay } from "node:timers/promises";
import { lazySync, sql } from "@k2b/cloud";
import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { type CodeEventCatchupInput, CodeEventCatchupInputSchema, CodeEventCatchupStatusSchema } from "@k2b/cloud/code";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { AppEventEnvelopeSchema } from "@k2b/cloud/contracts/app-events";
import { authorizeResourceEvent, type ResourceEventBinding } from "@k2b/cloud/services/app-events";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import type { PumpConfig, PumpState } from "@k2b/sync";
import { z } from "zod";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { CODE_EVENT_CONSUMER } from "./event-subscriptions";
import { codeEventTargetKey } from "./events";
import { codeSettings } from "./settings";
import { findCode, insertCodeRun, readCode } from "./store";
import { requireCodeVersionApproval } from "./versions";

type Input = CodeEventCatchupInput & { codeId: string; requestDigest: string; capacityDeadline: number };
type Item = { key: string; event: Input["events"][number] };
const key = (codeId: string, operationId: string) => `${codeId}:${operationId}`;

/** Uses the same checkpointed Sync pump as Mail's historical rule runs. It never publishes platform events. */
export const codeEventCatchupPumpConfig: PumpConfig<Input, number, Item> = {
  id: "core:code-event-catchup",
  batchSize: 20,
  // The record contains the snapshot, a duplicated dispatch page, and checkpoint metadata.
  maxPageBytes: 3 * 64 * 1024,
  dispatchConcurrency: 1,
  retention: { terminalMs: 30 * 86_400_000 },
  retry: { maxAttempts: 3, backoffMs: [1_000, 2_000, 4_000] },
  pull: async ({ input, cursor, limit }) => {
    const from = cursor ?? 0;
    const to = Math.min(from + limit, input.events.length);
    return {
      items: input.events.slice(from, to).map((event) => ({ key: codeEventTargetKey(input.versionId, event), event })),
      nextCursor: to < input.events.length ? to : null,
    };
  },
  dispatch: async ({ input, item, signal }) => {
    signal.throwIfAborted();
    const backlog = await codeSettings.get("core.code.event_backlog");
    if (backlog < 2) throw new CodeDataError("CONFLICT", "Catch-up requires an event backlog budget of at least two.");
    // At most half the backlog is available to historical admission; live mail retains capacity.
    while (true) {
      const operation = await pump().get({ key: key(input.codeId, input.operationId) });
      if (operation?.status === "canceled") return;
      const [subscription] = await sql<{ resource_binding: ResourceEventBinding }[]>`SELECT resource_binding FROM events.app_subscriptions
      WHERE state='active' AND event_type=${item.event.type} AND version=${item.event.version}
        AND resource_binding->>'consumer'=${CODE_EVENT_CONSUMER} AND resource_binding->>'key'=${input.codeId}`;
      if (!subscription || !(await authorizeResourceEvent("core", subscription.resource_binding, item.event, signal)))
        throw new CodeDataError("CONFLICT", "The handler's resource access or execution mandate is unavailable.");
      const admitted = await sql.begin(async (db) => {
        await db`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
        await db`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
        const code = await findCode(input.codeId, db);
        if (!code || code.state !== "active" || code.activeVersionId !== input.versionId)
          throw new CodeDataError("CONFLICT", "Catch-up version is no longer active. Start a new operation for the new version.");
        await requireCodeVersionApproval(code, input.versionId, db);
        const [execution] = await db`SELECT account.id FROM auth.service_accounts account
        JOIN auth.mandates mandate ON mandate.subject_service_account_id=account.id
        JOIN events.app_subscriptions subscription ON subscription.resource_binding->>'mandateId'=mandate.id::text
        WHERE account.id=${code.serviceAccountId}::uuid AND account.kind='code' AND account.status='active'
          AND mandate.owner_app_id='runner' AND mandate.workload_type='code.version' AND mandate.workload_id=${input.versionId}
          AND mandate.subject_kind='service_account' AND mandate.state='active' AND mandate.confirmed_at IS NOT NULL
          AND (mandate.expires_at IS NULL OR mandate.expires_at>clock_timestamp())
          AND mandate.revision=(subscription.resource_binding->>'mandateRevision')::int
          AND subscription.state='active' AND subscription.resource_binding=${JSON.stringify(subscription.resource_binding)}::text::jsonb
          AND subscription.event_type=${item.event.type} AND subscription.version=${item.event.version}
        FOR SHARE OF account,mandate,subscription`;
        if (!execution) throw new CodeDataError("CONFLICT", "The handler's active execution binding changed.");
        const [existing] = await db`SELECT run_id FROM code.run_requests WHERE code_id=${code.id} AND request_key=${item.key}`;
        if (existing) return true;
        const [waiting] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM code.runs
        WHERE code_id=${code.id} AND trigger='event' AND state IN ('queued','running')`;
        if ((waiting?.count ?? 0) >= Math.floor(backlog / 2)) return false;
        const [version] = await db<{ manifest: unknown }[]>`SELECT manifest FROM code.versions WHERE id=${input.versionId}::uuid`;
        const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
        const entry = manifest.entrypoints.find(
          (e) => e.kind === "event" && e.event?.type === item.event.type && e.event.version === item.event.version,
        );
        if (
          !entry?.event ||
          manifest.ai ||
          code.owner.kind !== "resource" ||
          entry.event.place.type !== code.owner.ref.type ||
          entry.event.place.id !== code.owner.ref.id ||
          item.event.place?.type !== code.owner.ref.type ||
          item.event.place.id !== code.owner.ref.id
        )
          throw new CodeDataError("BAD_INPUT", "Catch-up requires a non-AI handler for this Code owner.");
        signal.throwIfAborted();
        const runId = await insertCodeRun(
          { codeId: code.id, versionId: input.versionId, trigger: "event", entrypoint: entry.entrypoint, input: item.event },
          db,
        );
        await db`INSERT INTO code.run_requests(code_id,request_key,run_id) VALUES(${code.id},${item.key},${runId}::uuid),
        (${code.id},${`historical:${item.key}`},${runId}::uuid)`;
        await db`UPDATE code.runs SET event_subject_key=${`${item.event.type}@${item.event.version}:${code.owner.ref.type}:${code.owner.ref.id}`},
        event_sequence=(SELECT sequence FROM code.run_outbox WHERE run_id=${runId}::uuid) WHERE id=${runId}::uuid`;
        signal.throwIfAborted();
        return true;
      });
      if (admitted) return;
      if (Date.now() >= input.capacityDeadline)
        throw new Error("Catch-up waited for its capacity budget; resume the saved snapshot when runs finish.");
      await delay(1_000, undefined, { signal });
    }
  },
};
const mutationMutex = lazySync((sync) => sync.mutex({ id: "core:code-event-catchup-start", ttlMs: 30_000, retry: { maxAttempts: 1 } }));
const pump = lazySync((sync) => sync.pump(codeEventCatchupPumpConfig));
const status = (state: PumpState<Input, number>) =>
  CodeEventCatchupStatusSchema.parse({
    operationId: state.input.operationId,
    versionId: state.input.versionId,
    status: state.status,
    total: state.input.events.length,
    dispatched: state.dispatched,
    failureCount: state.failureCount,
    lastError: state.lastError ?? null,
    createdAt: new Date(state.createdAt).toISOString(),
    updatedAt: new Date(state.updatedAt).toISOString(),
  });
async function editor(codeId: string, context: CodeContext) {
  codePerson(context, true);
  const { code } = await readCode(codeId, context);
  await requireCodePermission(code, context, true);
  return code;
}
export async function readCodeEventCatchup(codeId: string, operationId: string, context: CodeContext) {
  await editor(codeId, context);
  const state = await pump().get({ key: key(codeId, z.uuid().parse(operationId)) });
  if (!state) throw new CodeDataError("NOT_FOUND", "Catch-up operation not found.");
  const result = status(state);
  if (state.status === "running") {
    const budget = await codeSettings.get("core.code.event_backlog");
    const [waiting] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM code.runs
      WHERE code_id=${codeId} AND trigger='event' AND state IN ('queued','running')`;
    if ((waiting?.count ?? 0) >= Math.floor(budget / 2)) result.status = "waiting";
  }
  return result;
}
export async function startCodeEventCatchup(codeId: string, raw: CodeEventCatchupInput, context: CodeContext) {
  const input = CodeEventCatchupInputSchema.parse(raw);
  const code = await editor(codeId, context);
  const operationKey = key(codeId, input.operationId);
  const existing = await pump().get({ key: operationKey });
  if (existing) {
    if (existing.input.requestDigest !== approvalArgsDigest(input))
      throw new CodeDataError("CONFLICT", "Operation ID was used for a different catch-up snapshot.");
    return status(existing);
  }
  if (code.state !== "active" || code.activeVersionId !== input.versionId || code.owner.kind !== "resource")
    throw new CodeDataError("CONFLICT", "Catch-up requires the active resource Code version.");
  const [version] = await sql<
    { manifest: unknown }[]
  >`SELECT manifest FROM code.versions WHERE id=${input.versionId}::uuid AND code_id=${code.id}`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  if (manifest.ai) throw new CodeDataError("BAD_INPUT", "AI handlers run only for future incoming messages.");
  const resolvedEvents: Input["events"] = [];
  const catalogs = new Map<string, Awaited<ReturnType<typeof getCapabilityCatalogApp>>>();
  for (const event of input.events) {
    if (!catalogs.has(event.source))
      catalogs.set(event.source, await getCapabilityCatalogApp(event.source, context.locale, context.authority));
    const catalog = catalogs.get(event.source)!;
    const declaration =
      catalog.ok && catalog.data
        ? catalog.data.manifest.events?.find((e) => `${event.source}.${e.localId}` === event.type && e.version === event.version)
        : undefined;
    const entry = manifest.entrypoints.find((e) => e.kind === "event" && e.event?.type === event.type && e.event.version === event.version);
    if (
      !declaration?.catchup ||
      !entry?.event ||
      event.subject.type !== `${event.source}.${declaration.subject}` ||
      event.place?.type !== code.owner.ref.type ||
      event.place.id !== code.owner.ref.id ||
      entry.event.place.type !== code.owner.ref.type ||
      entry.event.place.id !== code.owner.ref.id ||
      !z.fromJSONSchema(declaration.dataSchema).safeParse(event.data).success
    )
      throw new CodeDataError("BAD_INPUT", "Historical event does not match a catch-up declaration and owner.");
    const invocation = { appId: event.source, capabilityId: declaration.catchup, input: { id: event.subject.id }, signal: context.signal };
    const resolved =
      context.authority.credentialKind === "invocation" && context.query
        ? await context.query(invocation, AppEventEnvelopeSchema)
        : await invokeCapabilityWithDataSchema({ ...invocation, kind: "query" }, AppEventEnvelopeSchema, {
            authority: context.authority,
            locale: context.locale,
            signal: context.signal,
          });
    if (!resolved.ok) throw new CodeDataError("FORBIDDEN", "Historical source cannot resolve this message with your current permission.");
    const canonical = resolved.data.data;
    if (
      canonical.source !== event.source ||
      canonical.type !== event.type ||
      canonical.version !== event.version ||
      canonical.subject.type !== event.subject.type ||
      canonical.subject.id !== event.subject.id ||
      canonical.place?.type !== code.owner.ref.type ||
      canonical.place.id !== code.owner.ref.id ||
      !z.fromJSONSchema(declaration.dataSchema).safeParse(canonical.data).success
    )
      throw new CodeDataError("BAD_INPUT", "Historical source returned an incompatible occurrence.");
    resolvedEvents.push(canonical);
  }
  // Bound the authoritative snapshot too, rather than trusting the size of caller references.
  CodeEventCatchupInputSchema.parse({ ...input, events: resolvedEvents });
  const mutex = mutationMutex();
  const lock = await mutex.acquire({ resource: operationKey });
  if (!lock) throw new CodeDataError("CONFLICT", "Catch-up is being started. Read its status before retrying.");
  try {
    const stored = await pump().get({ key: operationKey });
    if (stored) {
      if (stored.input.requestDigest !== approvalArgsDigest(input))
        throw new CodeDataError("CONFLICT", "Operation ID was used for a different catch-up snapshot.");
      return status(stored);
    }
    const wallMs = await codeSettings.get("core.code.wall_clock_ms");
    await pump().start({
      key: operationKey,
      input: {
        ...input,
        events: resolvedEvents,
        codeId,
        requestDigest: approvalArgsDigest(input),
        capacityDeadline: Date.now() + input.events.length * wallMs,
      },
    });
    return readCodeEventCatchup(codeId, input.operationId, context);
  } finally {
    await mutex.release(lock);
  }
}
export async function cancelCodeEventCatchup(codeId: string, operationId: string, context: CodeContext) {
  await editor(codeId, context);
  await pump().cancel({ key: key(codeId, z.uuid().parse(operationId)) });
  return readCodeEventCatchup(codeId, operationId, context);
}
/** Resume the saved snapshot with a fresh operation; per-version message receipts skip admitted items. */
export async function resumeCodeEventCatchup(codeId: string, operationId: string, newOperationId: string, context: CodeContext) {
  await editor(codeId, context);
  const state = await pump().get({ key: key(codeId, z.uuid().parse(operationId)) });
  if (!state) throw new CodeDataError("NOT_FOUND", "Catch-up snapshot expired.");
  if (state.status !== "failed" && state.status !== "canceled")
    throw new CodeDataError("CONFLICT", "Only stopped catch-up operations can resume.");
  return startCodeEventCatchup(
    codeId,
    { versionId: state.input.versionId, events: state.input.events, operationId: z.uuid().parse(newOperationId) },
    context,
  );
}
export async function startCodeEventCatchupRuntime() {
  const worker = await pump().process();
  return async () => {
    worker.stop();
    await worker.drain();
  };
}
