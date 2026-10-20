import { expect, jest, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { type CapabilityExecutionInput, recordCapabilityExecution } from "./executions";

const input: CapabilityExecutionInput = {
  requestId: "recording-deadline-test",
  origin: "http",
  appId: "demo",
  capability: "demo.read",
  kind: "query",
  destructive: false,
  status: "succeeded",
  startedAt: new Date("2026-10-20T00:00:00Z"),
  completedAt: new Date("2026-10-20T00:00:01Z"),
};

for (const stall of ["connection", "statement setup", "insert"] as const) {
  test(`execution recording bounds a stalled ${stall} and prevents late writes or commits`, async () => {
    jest.useFakeTimers();
    let elapsed = 0;
    const now = spyOn(performance, "now").mockImplementation(() => elapsed);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
      savepoint: () => {
        throw new Error("Unexpected savepoint");
      },
    });
    let insertStarts = 0;
    let committed = false;
    const tx = new Proxy(client, {
      apply(_target, _receiver, [strings]) {
        const statement = strings.join("?");
        if (statement.includes("set_config")) {
          if (stall === "statement setup") {
            entered.resolve();
            return release.promise.then(() => []);
          }
          return Promise.resolve([]);
        }
        expect(statement).toContain("INSERT INTO capabilities.executions");
        insertStarts += 1;
        if (stall === "insert") {
          entered.resolve();
          return release.promise.then(() => [{ id: "recorded" }]);
        }
        return Promise.resolve([{ id: "recorded" }]);
      },
    });
    let late: Promise<unknown> | undefined;
    const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected transaction callback");
      const execute = async () => {
        if (stall === "connection") {
          entered.resolve();
          await release.promise;
        }
        const result = await run(tx);
        committed = true;
        return result;
      };
      const result = execute();
      late = result.catch(() => undefined);
      return result;
    });
    try {
      const pending = recordCapabilityExecution(input);
      // Attach the rejection handler before delivering the deadline.
      const observed = pending.catch((error: unknown) => error);
      await entered.promise;
      elapsed = 10_000;
      jest.advanceTimersByTime(10_000);
      expect(await observed).toMatchObject({ name: "TimeoutError" });
      release.resolve();
      await late;
      expect(insertStarts).toBe(stall === "insert" ? 1 : 0);
      expect(committed).toBe(false);
    } finally {
      release.resolve();
      await late;
      begin.mockRestore();
      now.mockRestore();
      jest.useRealTimers();
      await client.close();
    }
  });
}

test("execution SQL uses the remaining budget after waiting for a connection", async () => {
  let elapsed = 0;
  const now = spyOn(performance, "now").mockImplementation(() => elapsed);
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const tx = new Proxy(client, {
    apply(_target, _receiver, [strings, timeout]) {
      if (strings.join("?").includes("set_config")) {
        expect(timeout).toBe("4000ms");
        return Promise.resolve([]);
      }
      return Promise.resolve([{ id: "recorded" }]);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    elapsed = 6_000;
    return run(tx);
  });
  try {
    expect(await recordCapabilityExecution(input)).toBe("recorded");
  } finally {
    begin.mockRestore();
    now.mockRestore();
    await client.close();
  }
});
