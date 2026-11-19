import { AI_WAKEUP_MIN_INTERVAL_MINUTES } from "./wakeup-contracts";

/** One cadence for scheduler registration and delivery retries. */
export const AI_WAKEUP_SCHEDULE = { cron: "* * * * *", timezone: "UTC", intervalMs: 60_000 } as const;

/** Delays 1+2+4+8 ticks fit the minimum fifteen-minute alarm interval;
 * the fifth failed attempt becomes an actionable missed alarm. */
export const AI_WAKEUP_FAILURE_LIMIT =
  1 + Math.floor(Math.log2((AI_WAKEUP_MIN_INTERVAL_MINUTES * 60_000) / AI_WAKEUP_SCHEDULE.intervalMs + 1));
