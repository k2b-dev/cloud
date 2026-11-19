import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { AiWakeupError } from "@k2b/cloud/ai";
import * as services from "@k2b/cloud/services";

// The module's logger is made on import: capture its warnings before the module loads.
const warnings: { message: string; metadata?: Record<string, unknown> }[] = [];
const original = services.logger;
const logger = spyOn(services, "logger").mockImplementation((source) => ({
  ...original(source),
  warn: (message: string, metadata?: Record<string, unknown>) => void warnings.push({ message, metadata }),
}));
const { loadChatWakeups } = await import("./chat-context");
afterEach(() => {
  warnings.length = 0;
});
afterAll(() => logger.mockRestore());

test("a chat whose viewer may not manage alarms has none, without a warning", async () => {
  for (const code of ["forbidden", "not_found"] as const)
    expect(await loadChatWakeups("cHt234", () => Promise.reject(new AiWakeupError(code, "refused")))).toBeUndefined();
  expect(warnings).toEqual([]);
});

test("any other failure leaves the alarms out and is logged, so the context still loads", async () => {
  expect(await loadChatWakeups("cHt234", () => Promise.reject(new Error("connection terminated")))).toBeUndefined();
  expect(warnings.map((warning) => warning.metadata)).toEqual([{ chatId: "cHt234", error: "connection terminated" }]);
});

test("the chat's alarms pass through unchanged", async () => {
  const wakeups = { items: [], limit: 5, paused: false };
  expect(await loadChatWakeups("cHt234", async () => wakeups)).toBe(wakeups);
});
