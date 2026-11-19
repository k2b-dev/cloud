import { expect, test } from "bun:test";
import { AiWakeupError } from "@k2b/cloud/ai";
import { loadChatWakeups } from "./chat-context";

/** Collects the warnings `loadChatWakeups` gives, without touching the shared logger. */
const recorder = () => {
  const warnings: { message: string; metadata: Record<string, unknown> }[] = [];
  return { warnings, warn: (message: string, metadata: Record<string, unknown>) => void warnings.push({ message, metadata }) };
};

test("a chat whose viewer may not manage alarms has none, without a warning", async () => {
  const { warnings, warn } = recorder();
  for (const code of ["forbidden", "not_found"] as const)
    expect(await loadChatWakeups("cHt234", () => Promise.reject(new AiWakeupError(code, "refused")), warn)).toBeUndefined();
  expect(warnings).toEqual([]);
});

test("any other failure leaves the alarms out and is logged, so the context still loads", async () => {
  const { warnings, warn } = recorder();
  expect(await loadChatWakeups("cHt234", () => Promise.reject(new Error("connection terminated")), warn)).toBeUndefined();
  expect(warnings.map((warning) => warning.metadata)).toEqual([{ chatId: "cHt234", error: "connection terminated" }]);
});

test("the chat's alarms pass through unchanged", async () => {
  const wakeups = { items: [], limit: 5, paused: false };
  expect(await loadChatWakeups("cHt234", async () => wakeups)).toBe(wakeups);
});
