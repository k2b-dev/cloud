import type { AppLifecycle } from "@k2b/cloud/contracts";
import { logger, trace } from "@k2b/cloud/services";
import { MAINTENANCE_ID as ID, maintenanceScheduler as scheduler } from "./maintenance-schedule";
import { migrate } from "./migrate";
import { filesService } from "./service";

const log = logger("filesv2:maintenance");
let worker: Awaited<ReturnType<ReturnType<typeof scheduler>["process"]>> | undefined;

export async function runFilesMaintenance(
  input: { signal: AbortSignal; heartbeat: () => Promise<void> },
  service: Pick<typeof filesService, "maintain" | "reconcileUserHomes"> = filesService,
) {
  let maintenance: Awaited<ReturnType<typeof service.maintain>>;
  try {
    maintenance = await service.maintain(input);
  } catch (error) {
    try {
      await service.reconcileUserHomes(input);
    } catch (reconcileError) {
      log.error("Home reconciliation failed after directory maintenance failed", { error: String(reconcileError) });
    }
    throw error;
  }
  const homes = await service.reconcileUserHomes(input);
  return { homes, ...maintenance };
}

export const filesLifecycle: AppLifecycle = {
  setup: migrate,
  async start() {
    await scheduler().create({
      id: ID,
      cron: "* * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "filesv2", family: "filesv2:maintenance", source: ID, label: "Files directory maintenance" },
      async process(context) {
        await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("scheduler", ID, context.runId),
            name: "Files directory maintenance",
            source: ID,
            appId: "filesv2",
            category: "schedule",
          },
          async () => {
            const input = { signal: context.signal, heartbeat: () => context.heartbeat() };
            return runFilesMaintenance(input);
          },
          { summarize: (result) => result },
        );
      },
    });
    worker ??= await scheduler().process();
    try {
      await scheduler().runNow({ id: ID, requestId: crypto.randomUUID() });
    } catch (error) {
      log.error("Startup home reconciliation request failed; the periodic schedule will retry", { error: String(error) });
    }
  },
  async stop() {
    const current = worker;
    worker = undefined;
    current?.stop();
    await current?.drain();
  },
};
