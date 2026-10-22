import type { ScheduleContext, Scheduler } from "@k2b/sync";
import { evaluateDueAlerts } from "./alert-evaluator";
import { fanoutBaseNotices } from "./base-notifications";
import { checkSourceFreshness } from "./source-freshness";

/** Match the other per-minute scans: at most 20 pages, no new page after 50 s.
 * A page with no admins still advances the durable cursor; only null means idle. */
export const fanoutPendingBaseNotices = async (context: Pick<ScheduleContext, "signal" | "heartbeat">) => {
  const deadline = performance.now() + 50_000;
  let recipients = 0;
  for (let page = 0; page < 20 && performance.now() < deadline && !context.signal.aborted; page++) {
    await context.heartbeat();
    if (context.signal.aborted) break;
    const count = await fanoutBaseNotices();
    if (count === null) break;
    recipients += count;
  }
  return { recipients };
};

/** Registered on every process start. PostgreSQL owns due times, leases and
 * event identity, so delayed/repeated ticks never replay historical SQL. */
export const registerAlertSchedules = async (scheduler: Pick<Scheduler, "create">, stopSignal?: AbortSignal) => {
  await scheduler.create({
    id: "pulse:alerts:evaluate-due",
    cron: "* * * * *",
    misfire: "latest",
    meta: { appId: "pulse", family: "pulse:alerts", label: "Pulse alert checks", source: "pulse:alerts:evaluate-due" },
    process: async (context) => {
      await evaluateDueAlerts(undefined, {
        signal: stopSignal ? AbortSignal.any([context.signal, stopSignal]) : context.signal,
        heartbeat: context.heartbeat,
      });
    },
  });
  await scheduler.create({
    id: "pulse:sources:freshness",
    cron: "* * * * *",
    misfire: "latest",
    meta: { appId: "pulse", family: "pulse:alerts", label: "Pulse source freshness", source: "pulse:sources:freshness" },
    process: async (context) => {
      await checkSourceFreshness(undefined, {
        signal: stopSignal ? AbortSignal.any([context.signal, stopSignal]) : context.signal,
        heartbeat: context.heartbeat,
      });
    },
  });
  await scheduler.create({
    id: "pulse:notifications:fanout",
    cron: "* * * * *",
    misfire: "latest",
    meta: { appId: "pulse", family: "pulse:alerts", label: "Pulse base notification recipients", source: "pulse:notifications:fanout" },
    process: async (context) => {
      await fanoutPendingBaseNotices({
        signal: stopSignal ? AbortSignal.any([context.signal, stopSignal]) : context.signal,
        heartbeat: context.heartbeat,
      });
    },
  });
};
