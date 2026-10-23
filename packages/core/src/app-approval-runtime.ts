import { lazySync } from "@k2b/cloud";
import { appApproval, knownBrowsers, pwaDevices } from "@k2b/cloud/services";
import type { Worker } from "@k2b/sync";
import { sql } from "bun";
import { cleanupTerminalLogins, notifyPendingOAuthNewAccess } from "./api/identity-oauth-device-approval";
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
      meta: {
        appId: "core",
        family: "app-approval",
        label: "App device enrollment notices, expiry, new-browser and new-access notices, and known-browser cleanup",
      },
      process: async ({ signal }) => {
        // The steps are independent: a failing step never skips the later ones, and the run still fails.
        const errors: unknown[] = [];
        for (const step of [
          () => knownBrowsers.cleanup(sql, { signal }),
          () => knownBrowsers.maintainNotices(sql, sender.sendNewBrowserSignIn, { signal }),
          () => appApproval.maintain(sender.sendDeviceEnrollment, signal),
          () => cleanupTerminalLogins(),
          () => notifyPendingOAuthNewAccess(sender.sendOAuthNewAccess, signal),
        ]) {
          try {
            await step();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw errors[0];
      },
    });
    await scheduler().create({
      id: "pwa-maintenance",
      cron: "* * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { appId: "core", family: "app-approval", label: "Cloud app pairing expiry, new-phone notices and phones of expired accounts" },
      process: async ({ signal }) => pwaDevices.maintain(sender.sendAppDevicePaired, signal),
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
