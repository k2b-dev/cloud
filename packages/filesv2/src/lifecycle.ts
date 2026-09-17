import { lazySync } from "@k2b/cloud";
import type { AppLifecycle } from "@k2b/cloud/contracts";
import { trace } from "@k2b/cloud/services";
import { migrate } from "./migrate";
import { filesService } from "./service";

const ID = "filesv2:directory-maintenance";
const scheduler = lazySync((sync) =>
  sync.scheduler({ id: ID, delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [5_000, 15_000] } }),
);
let worker: Awaited<ReturnType<ReturnType<typeof scheduler>["process"]>> | undefined;

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
          () => filesService.maintain({ signal: context.signal, heartbeat: () => context.heartbeat() }),
          { summarize: (result) => result },
        );
      },
    });
    worker ??= await scheduler().process();
  },
  async stop() {
    const current = worker;
    worker = undefined;
    current?.stop();
    await current?.drain();
  },
};
