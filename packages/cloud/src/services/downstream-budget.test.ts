import { expect, test } from "bun:test";
import { createDownstreamBudget, DownstreamBusyError } from "./downstream-budget";

test("capacity refusal and Valkey failure fail closed with visible busy", async () => {
  for (const fail of [false, true]) {
    const budget = createDownstreamBudget({
      namespace: () => "test",
      client: async () => ({
        send: async () => {
          if (fail) throw new Error("private connection detail");
          return 0;
        },
      }),
    });
    await expect(budget.acquire({ downstream: "gotenberg", timeoutMs: 1000, signal: AbortSignal.timeout(1000) })).rejects.toBeInstanceOf(
      DownstreamBusyError,
    );
  }
});

test("cancellation does not wait for Valkey and releases an admission that arrives late", async () => {
  let complete: (value: number) => void = () => {};
  let acquiring: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    acquiring = resolve;
  });
  const reply = new Promise<number>((resolve) => {
    complete = resolve;
  });
  const commands: string[] = [];
  const budget = createDownstreamBudget({
    namespace: () => "test",
    client: async () => ({
      send: async (command) => {
        commands.push(command);
        if (command === "EVAL") {
          acquiring();
          return reply;
        }
        return 1;
      },
    }),
  });
  const controller = new AbortController();
  const pending = budget.acquire({ downstream: "smtp", timeoutMs: 60_000, signal: controller.signal });
  await reached;
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  complete(1);
  await Bun.sleep(0);
  expect(commands).toEqual(["EVAL", "ZREM"]);
});

test("already cancelled work never contacts Valkey", async () => {
  let called = false;
  const budget = createDownstreamBudget({
    client: async () => {
      called = true;
      throw new Error("unused");
    },
  });
  await expect(budget.acquire({ downstream: "smtp", timeoutMs: 1000, signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow(
    "cancelled",
  );
  expect(called).toBe(false);
});

test("release failures cannot turn an already completed send into another attempt", async () => {
  const budget = createDownstreamBudget({
    namespace: () => "test",
    client: async () => ({
      send: (command) => {
        if (command === "EVAL") return Promise.resolve(1);
        throw new Error("disconnected during cleanup");
      },
    }),
  });
  const release = await budget.acquire({ downstream: "smtp", timeoutMs: 1000, signal: AbortSignal.timeout(1000) });
  expect(() => release()).not.toThrow();
});
