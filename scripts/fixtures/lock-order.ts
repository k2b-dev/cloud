/**
 * Lock-order fixture for races that a lock should serialize.
 *
 * Two changes started with `Promise.all` often run one after the other by
 * chance, so a test can stay green when the lock disappears. Here the test
 * holds the lock itself, together with the rows the changes write, and starts
 * each change only once the one before it waits:
 *
 * - a change that takes the lock waits before it reads anything, so the
 *   changes pass the lock in the given order and each sees the commits before
 *   it;
 * - a change that skips the lock reads at once and then waits for its rows, so
 *   every change decides on the state from before all of them, which is the
 *   race the lock exists to prevent.
 */
import { sql } from "bun";

type Holder = Awaited<ReturnType<typeof sql.reserve>>;

/** Sessions that wait for `pid`, directly or behind another waiter: later row-lock waiters queue behind the first. */
const waitingBehind = async (pid: number): Promise<number> => {
  const [row] = await sql<{ waiting: number }[]>`
    WITH RECURSIVE waiting AS (
      SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
      UNION
      SELECT activity.pid FROM pg_stat_activity activity JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
    )
    SELECT COUNT(*)::int AS waiting FROM waiting
  `;
  return row?.waiting ?? 0;
};

/**
 * Runs `changes` while a transaction holds what `lock` takes: the lock the changes should serialize
 * on and the rows they write. Each change starts once the previous one waits or has finished; then the
 * transaction commits and every result is returned in order.
 */
export const inLockOrder = async <T>(lock: (holder: Holder) => Promise<unknown>, changes: readonly (() => Promise<T>)[]): Promise<T[]> => {
  const holder = await sql.reserve();
  let open = false;
  try {
    await holder`BEGIN`;
    open = true;
    await lock(holder);
    const [backend] = await holder<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
    let settled = 0;
    const running: Promise<T>[] = [];
    for (const change of changes) {
      const run = change().finally(() => settled++);
      // Promise.all below reports the failure; this only keeps an early one from counting as unhandled.
      run.catch(() => {});
      running.push(run);
      const deadline = performance.now() + 5_000;
      while ((await waitingBehind(backend!.pid)) + settled < running.length) {
        if (performance.now() >= deadline) throw new Error("A change neither waited for the held locks nor finished");
        await Bun.sleep(10);
      }
    }
    await holder`COMMIT`;
    open = false;
    return await Promise.all(running);
  } finally {
    if (open) await holder`ROLLBACK`;
    holder.release();
  }
};
