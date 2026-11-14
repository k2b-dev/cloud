import { lazySync } from "@k2b/cloud";

// Match the old resource declaration exactly. No process, cron or occurrence worker is installed.
const retiredScheduler = lazySync((sync) => sync.scheduler({ id: "core-ai-chat-tasks", delivery: { maxAttempts: 1 } }));

/** Delete durable broker timers on every restart, including the former recovery timer. */
export async function retireChatTaskSchedules(
  scheduler: { list(): Promise<ReadonlyArray<{ id: string }>>; delete(input: { id: string }): Promise<unknown> } = retiredScheduler(),
): Promise<void> {
  for (const schedule of await scheduler.list()) await scheduler.delete({ id: schedule.id });
}
