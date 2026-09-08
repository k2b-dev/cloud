/** Admin access to application-owned Sync diagnostics and recovery. */
import type { SyncDeadLetterEntry, SyncDeadLetterKind, SyncDeadLetterStoreView, SyncScheduleView } from "../../services/sync-ops";
import { arg, command, confirmFlag, flag, type CloudCliContext } from "../index";
import { apiGet, apiJson, printJsonOrTable, queryString } from "./shared";

export type SyncOverview = {
  sampledAt: string;
  apps: { appId: string; appName: string; status: string; error: string | null; health: { state: string; connection: string } | null }[];
  resources: { appId: string; appName: string; kind: string; id: string; state: string; deadLetters: number | null; error?: string }[];
  deadLetters: (SyncDeadLetterEntry & { appId: string; store: string; kind: SyncDeadLetterKind })[];
  truncatedStores: string[];
  schedules: (SyncScheduleView & { appId: string; appName: string })[];
};
const filters = {
  app: flag.string({ description: "App ID" }),
  resource: flag.string({ description: "Resource ID filter" }),
  problems: flag.boolean({ description: "Only resources and apps needing attention" }),
};
const storeArgs = { app: arg.required(), kind: arg.required({ description: "queue, job, or topic" }), store: arg.required() };
const entryArgs = { ...storeArgs, message: arg.required() };
const storePath = (args: { app: string; kind: string; store: string }) => {
  if (!["queue", "job", "topic"].includes(args.kind)) throw new Error("kind must be queue, job, or topic.");
  return `/api/gateway/sync/dead-letters/${encodeURIComponent(args.app)}/${args.kind}/${encodeURIComponent(args.store)}`;
};
const scheduleArgs = { app: arg.required(), scheduler: arg.required(), id: arg.required() };
const schedulePath = (args: { app: string; scheduler: string; id: string }) =>
  `/api/gateway/sync/schedules/${encodeURIComponent(args.app)}/${encodeURIComponent(args.scheduler)}/${encodeURIComponent(args.id)}`;
const outputRows = <T extends Record<string, unknown>>(
  ctx: CloudCliContext,
  raw: unknown,
  rows: T[],
  keys: (keyof T & string)[],
  metadata: Record<string, unknown>,
) => {
  if (ctx.options.output === "jsonl") {
    ctx.jsonLine({ type: "snapshot", ...metadata });
    for (const row of rows) ctx.jsonLine({ type: "entry", ...row });
  } else
    printJsonOrTable(
      ctx,
      raw,
      rows,
      keys.map((key) => ({ key })),
    );
};

export const syncCommands = [
  command("sync status", {
    summary: "Read a current Sync snapshot across registered apps",
    flags: filters,
    run: async ({ ctx, flags }) => {
      const result = await apiGet<SyncOverview>(ctx, `/api/gateway/sync${queryString(flags)}`);
      outputRows(
        ctx,
        result,
        result.apps.map((app) => ({
          app: app.appId,
          status: app.status,
          runtime: app.health?.state ?? "unknown",
          connection: app.health?.connection ?? "unknown",
          error: app.error,
        })),
        ["app", "status", "runtime", "connection", "error"],
        { sampledAt: result.sampledAt, apps: result.apps, truncatedStores: result.truncatedStores },
      );
    },
  }),
  command("sync resources list", {
    summary: "List Sync resource declarations and failures",
    flags: filters,
    run: async ({ ctx, flags }) => {
      const result = await apiGet<SyncOverview>(ctx, `/api/gateway/sync${queryString(flags)}`);
      outputRows(
        ctx,
        { sampledAt: result.sampledAt, apps: result.apps, items: result.resources },
        result.resources,
        ["appId", "kind", "id", "state", "deadLetters", "error"],
        { sampledAt: result.sampledAt, apps: result.apps },
      );
    },
  }),
  command("sync dead-letters list", {
    summary: "Page through one store, oldest retained failures first",
    args: storeArgs,
    flags: {
      cursor: flag.string({ description: "Opaque nextCursor from the previous page" }),
      limit: flag.int({ default: 20, min: 1, max: 100 }),
    },
    run: async ({ ctx, args, flags }) => {
      const result = await apiGet<{ store: SyncDeadLetterStoreView; nextCursor: string | null; sampledAt: string }>(
        ctx,
        `${storePath(args)}${queryString(flags)}`,
      );
      outputRows(ctx, result, result.store.entries, ["messageId", "streamSequence", "tenantId", "attempts", "failedAt", "reason"], {
        sampledAt: result.sampledAt,
        store: result.store.name,
        truncated: result.store.truncated,
        nextCursor: result.nextCursor,
      });
      if (ctx.options.output === "text" && result.nextCursor) ctx.print(`Next cursor: ${result.nextCursor}`);
    },
  }),
  command("sync dead-letters get", {
    summary: "Inspect a failure and its bounded payload preview",
    args: entryArgs,
    flags: { sequence: flag.int({ min: 1, description: "streamSequence from the queue/job list entry" }) },
    run: async ({ ctx, args, flags }) => {
      const result = await apiGet<{ entry: SyncDeadLetterEntry; sampledAt: string }>(
        ctx,
        `${storePath(args)}/${encodeURIComponent(args.message)}${queryString(flags)}`,
      );
      if (ctx.options.output === "jsonl") ctx.jsonLine(result);
      else ctx.json(result);
    },
  }),
  command("sync dead-letters requeue", {
    summary: "Requeue a queue/job failure with a new idempotency key",
    args: entryArgs,
    flags: { yes: confirmFlag() },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Requeue requires --yes.");
      if (args.kind === "topic") throw new Error("Topic failures require sync dead-letters replay with consumer and tenant.");
      ctx.json(await apiJson(ctx, "POST", `${storePath(args)}/requeue`, { messageId: args.message }));
    },
  }),
  command("sync dead-letters replay", {
    summary: "Replay a topic failure through its original consumer",
    args: { app: arg.required(), store: arg.required(), message: arg.required() },
    flags: { consumer: flag.string({ required: true }), tenant: flag.string({ required: true }), yes: confirmFlag() },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Replay requires --yes.");
      ctx.json(
        await apiJson(ctx, "POST", `${storePath({ ...args, kind: "topic" })}/replay`, {
          messageId: args.message,
          consumer: flags.consumer,
          tenantId: flags.tenant,
        }),
      );
    },
  }),
  command("sync dead-letters delete", {
    summary: "Permanently remove a dead letter",
    args: entryArgs,
    flags: { yes: confirmFlag() },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Deletion requires --yes.");
      ctx.json(await apiJson(ctx, "DELETE", `${storePath(args)}/${encodeURIComponent(args.message)}`));
    },
  }),
  command("sync schedules list", {
    summary: "List schedules, handler availability and last completion",
    flags: filters,
    run: async ({ ctx, flags }) => {
      const result = await apiGet<SyncOverview>(ctx, `/api/gateway/sync${queryString(flags)}`);
      outputRows(
        ctx,
        { sampledAt: result.sampledAt, apps: result.apps, items: result.schedules },
        result.schedules,
        ["appId", "schedulerId", "id", "nextRunAt", "handlerAvailable", "lastCompletedAt", "lastRunId", "lastError"],
        { sampledAt: result.sampledAt, apps: result.apps },
      );
    },
  }),
  command("sync schedules run", {
    summary: "Accept a manual run; use runs get to inspect completion",
    args: scheduleArgs,
    flags: {
      requestId: flag.string({
        name: "request-id",
        required: true,
        description: "Stable idempotency ID; reuse after an uncertain response",
      }),
      yes: confirmFlag(),
    },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Running a schedule requires --yes.");
      ctx.json(await apiJson(ctx, "POST", `${schedulePath(args)}/run-now`, { requestId: flags.requestId }));
    },
  }),
  command("sync schedules runs get", {
    summary: "Read one run result; incomplete means still pending",
    args: { ...scheduleArgs, run: arg.required() },
    flags: { timeoutMs: flag.int({ name: "timeout-ms", default: 0, min: 0, max: 30000 }) },
    run: async ({ ctx, args, flags }) => {
      ctx.json(await apiGet(ctx, `${schedulePath(args)}/runs/${encodeURIComponent(args.run)}${queryString(flags)}`));
    },
  }),
];
