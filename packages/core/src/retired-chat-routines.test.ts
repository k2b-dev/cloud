import { expect, test } from "bun:test";
import { retireChatTaskSchedules } from "./retired-chat-routines";

test("every restart removes old timers, including recovery, without registering or processing work", async () => {
  const ids = new Set(["task:old-task", "core:ai-chat-tasks:recover"]);
  const removed: string[] = [];
  const scheduler = {
    list: async () => [...ids].map((id) => ({ id })),
    delete: async ({ id }: { id: string }) => {
      removed.push(id);
      ids.delete(id);
    },
  };
  await retireChatTaskSchedules(scheduler);
  await retireChatTaskSchedules(scheduler);
  expect(ids.size).toBe(0);
  expect(removed).toEqual(["task:old-task", "core:ai-chat-tasks:recover"]);
});

test("failure to remove a durable timer fails startup visibly", async () => {
  await expect(
    retireChatTaskSchedules({
      list: async () => [{ id: "task:old-task" }],
      delete: async () => {
        throw new Error("broker unavailable");
      },
    }),
  ).rejects.toThrow("broker unavailable");
});

test("Core no longer advertises routine types, readers or actions", async () => {
  const { aiCapabilities } = await import("./capabilities");
  expect(Object.keys(aiCapabilities.types ?? {})).not.toContain("ai.task");
  for (const name of [...Object.keys(aiCapabilities.queries ?? {}), ...Object.keys(aiCapabilities.actions ?? {})]) {
    expect(name).not.toMatch(/^ai\.(tasks\.|task\.)/);
  }
  expect(aiCapabilities.actions["ai.chat.run"]).toBeDefined();
  expect(aiCapabilities.actions["ai.chat.deliver"]).toBeDefined();
});
