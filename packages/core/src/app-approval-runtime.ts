import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { appApproval } from "@valentinkolb/cloud/services";
import type { CoreNotificationSender } from "./notifications";

const scheduler = lazySync((sync) => sync.scheduler({ id: "core-app-approval", delivery: { maxAttempts: 2, backoffMs: [5000] } }));
let worker: Worker | undefined;

export const appApprovalRuntime = {
  async start(sender: CoreNotificationSender) {
    if (worker) return;
    await scheduler().create({
      id: "maintenance",
      cron: "* * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "core", family: "app-approval", label: "App device enrollment notices and expiry cleanup" },
      process: async ({ signal }) => appApproval.maintain(sender.sendDeviceEnrollment, signal),
    });
    worker = await scheduler().process({ concurrency: 1 });
  },
  async stop() {
    const current = worker;
    worker = undefined;
    current?.stop();
    await current?.drain();
  },
};
