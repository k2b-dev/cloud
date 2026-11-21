import { sql } from "@k2b/cloud";

/** Waits until at least `commits` backends wait, directly or through other waiters, on `blockerPid`. */
export async function waitForBlockedCommit(blockerPid: number, commits = 1) {
  const deadline = performance.now() + 10_000;
  while (true) {
    // A second waiter on the same row queues behind the first one, not behind the holder.
    const [row] = await sql<{ blocked: boolean }[]>`WITH RECURSIVE waiting AS (
      SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))
      UNION
      SELECT activity.pid FROM pg_stat_activity activity JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
      WHERE activity.datname = current_database()
    ) SELECT count(*) >= ${commits} AS blocked FROM waiting`;
    if (row?.blocked) return;
    if (performance.now() >= deadline) throw new Error("locks: account commit did not reach the held row");
    await Bun.sleep(10);
  }
}
