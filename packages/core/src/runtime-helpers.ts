/**
 * Core-specific lifecycle helpers.
 * Migrations, background jobs — nothing generic here.
 */

import { aiChatTasks, aiMaintenanceJobs, migrateCloudAi, seedCloudAiSkills } from "@k2b/cloud/ai";
import { startAiRuntime } from "@k2b/cloud/ai/runtime";
import {
  browserNotifications,
  lifecycleJobs,
  migrateWeather,
  startMandateMaintenance,
  startNotificationRuntime,
  stopNotificationRuntime,
} from "@k2b/cloud/services";
import { initializeIdentityAuthority, startIdentityKeyMaintenance } from "@k2b/cloud/services/identity";
import { aiChatTaskRuntime } from "./ai-chat-tasks-runtime";
import { deliverPendingAiMessages } from "./ai-inter-chat-messages";
import type { createAiNotificationService } from "./ai-notifications";
import { appApprovalRuntime } from "./app-approval-runtime";
import { migrate as migrateAnnouncements } from "./migrate/core/announcements";
import { migrate as migrateAppApproval } from "./migrate/core/app-approval";
import { migrate as migrateAudit } from "./migrate/core/audit";
import { migrate as migrateAuth } from "./migrate/core/auth";
import { migrate as migrateLogging } from "./migrate/core/logging";
import { migrate as migrateNotifications } from "./migrate/core/notifications";
import { migrate as migrateRailPreferences } from "./migrate/core/rail-preferences";
import { migrate as migrateSettings } from "./migrate/core/settings";
import { migrate as migrateWorkflows } from "./migrate/core/workflows";
import type { CoreNotificationSender } from "./notifications";

let stopCloudAiRuntime: (() => void) | null = null;
let stopIdentityMaintenance: (() => void) | null = null;
let stopMandateMaintenance: (() => void) | null = null;

/** Run all core database migrations (auth, notifications, settings, logging). */
export const runCoreSetup = async (): Promise<void> => {
  const steps = [
    { name: "auth", run: migrateAuth },
    { name: "rail-preferences", run: migrateRailPreferences },
    { name: "app-approval", run: migrateAppApproval },
    { name: "audit", run: migrateAudit },
    { name: "announcements", run: migrateAnnouncements },
    { name: "notifications", run: migrateNotifications },
    { name: "settings", run: migrateSettings },
    { name: "logging", run: migrateLogging },
    { name: "workflows", run: migrateWorkflows },
    { name: "weather", run: migrateWeather },
    { name: "ai", run: migrateCloudAi },
    { name: "ai-skills", run: seedCloudAiSkills },
  ];
  for (const step of steps) {
    console.log(`[setup] core:${step.name}`);
    await step.run();
  }
};

/** Start core background services (account lifecycle jobs). */
export const startCoreServices = async (
  notificationSender: CoreNotificationSender,
  aiNotifications: ReturnType<typeof createAiNotificationService>,
): Promise<void> => {
  try {
    await initializeIdentityAuthority();
    stopIdentityMaintenance = startIdentityKeyMaintenance();
    stopMandateMaintenance = startMandateMaintenance();
    await browserNotifications.start();
    await aiNotifications.start();
    stopCloudAiRuntime = startAiRuntime({
      onTurnFinalized: async ({ turnId, status, kind }) => {
        const task = await aiChatTasks.finalizeTurn({ turnId, status }).catch(() => null);
        await Promise.allSettled([
          ...(task?.failed ? [aiNotifications.notifyTaskNeedsAttention(task.occurrenceId)] : []),
          ...(status === "completed" && kind === "chat" ? [aiNotifications.notifyTurnCompleted(turnId)] : []),
          deliverPendingAiMessages(),
        ]);
      },
    });
    await aiMaintenanceJobs.start();
    await aiChatTaskRuntime.start();
    await deliverPendingAiMessages();
    await startNotificationRuntime();
    await appApprovalRuntime.start(notificationSender);
    await lifecycleJobs.start({ notificationSender });
  } catch (error) {
    stopIdentityMaintenance?.();
    stopIdentityMaintenance = null;
    stopMandateMaintenance?.();
    stopMandateMaintenance = null;
    stopCloudAiRuntime?.();
    stopCloudAiRuntime = null;
    await Promise.allSettled([
      aiMaintenanceJobs.stop(),
      aiChatTaskRuntime.stop(),
      aiNotifications.stop(),
      lifecycleJobs.stop(),
      appApprovalRuntime.stop(),
      stopNotificationRuntime(),
    ]);
    browserNotifications.stop();
    throw error;
  }
};

/** Stop core background services. */
export const stopCoreServices = async (aiNotifications?: ReturnType<typeof createAiNotificationService>): Promise<void> => {
  try {
    stopIdentityMaintenance?.();
    stopIdentityMaintenance = null;
    stopMandateMaintenance?.();
    stopMandateMaintenance = null;
    await Promise.all([lifecycleJobs.stop(), appApprovalRuntime.stop()]);
  } finally {
    try {
      await stopNotificationRuntime();
    } finally {
      try {
        stopCloudAiRuntime?.();
        stopCloudAiRuntime = null;
        await Promise.allSettled([aiChatTaskRuntime.stop(), aiMaintenanceJobs.stop(), aiNotifications?.stop()]);
      } finally {
        browserNotifications.stop();
      }
    }
  }
};

/** Boot the full core runtime: setup, start services, register shutdown hooks. */
export const bootRuntime = async (options: {
  runtime: unknown;
  skipSetup: boolean;
  notificationSender: CoreNotificationSender;
  aiNotifications: ReturnType<typeof createAiNotificationService>;
  shutdownTimeoutMs?: number;
  onShutdown?: () => Promise<void>;
}): Promise<void> => {
  if (!options.skipSetup) {
    await runCoreSetup();
  }
  await startCoreServices(options.notificationSender, options.aiNotifications);

  const shutdown = async () => {
    console.log("[shutdown] stopping core services…");
    await stopCoreServices(options.aiNotifications);
    if (options.onShutdown) await options.onShutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};
