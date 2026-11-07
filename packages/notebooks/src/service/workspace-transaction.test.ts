import { expect, mock, test } from "bun:test";

// Isolate platform module fixtures from other files' service graphs.
if (process.env.NOTEBOOKS_WORKSPACE_TRANSACTION_CHILD !== "1") {
  test("workspace transactions wake delivery only after commit", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, NOTEBOOKS_WORKSPACE_TRANSACTION_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  const entered = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let committed = false;
  const notify = mock(() => {
    expect(committed).toBe(true);
    return delivered.promise;
  });
  const tx = {};
  mock.module("@k2b/cloud", () => ({
    lazySync: () => () => ({}),
    sql: {
      begin: async <T>(run: (transaction: typeof tx) => Promise<T>) => {
        const result = await run(tx);
        entered.resolve();
        await commit.promise;
        committed = true;
        return result;
      },
    },
  }));
  mock.module("@k2b/cloud/services", () => ({ latestTopicCursor() {} }));
  mock.module("@k2b/cloud/services/outbox", () => ({ createPgOutbox: () => ({ notify }) }));
  const { workspaceTransaction } = await import("./workspace-events");

  test("commit wakes once without waiting for delivery; rollback never wakes", async () => {
    const result = workspaceTransaction(async (transaction) => {
      expect(Object.is(transaction, tx)).toBe(true);
      return "saved";
    });
    await entered.promise;
    expect(notify).not.toHaveBeenCalled();
    commit.resolve();
    expect(await result).toBe("saved");
    expect(notify).toHaveBeenCalledTimes(1);
    delivered.resolve();

    notify.mockClear();
    await expect(
      workspaceTransaction(async () => {
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(notify).not.toHaveBeenCalled();
  });
}
