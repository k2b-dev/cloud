import { expect, test } from "bun:test";
import { DeleteMessageSchema, EditMessageSchema, withinMessageMutationWindow } from "./contracts";

test("the ten-minute window is exclusive at its end and never permits future or invalid timestamps", () => {
  const sent = "2026-10-28T12:00:00.000Z";
  const at = Date.parse(sent);
  expect(withinMessageMutationWindow(sent, at)).toBe(true);
  expect(withinMessageMutationWindow(sent, at + 599_999)).toBe(true);
  expect(withinMessageMutationWindow(sent, at + 600_000)).toBe(false);
  expect(withinMessageMutationWindow(sent, at - 1)).toBe(false);
  expect(withinMessageMutationWindow("invalid", at)).toBe(false);
});
test("mutation input requires a stable retry key and revision, and accepts only bounded nonempty text", () => {
  const input = { clientId: "edit-1", revision: 4, body: "Keep **this** spacing.\n" };
  expect(EditMessageSchema.parse(input)).toEqual(input);
  expect(DeleteMessageSchema.parse({ clientId: "delete-1", revision: 4 })).toEqual({ clientId: "delete-1", revision: 4 });
  for (const change of [
    { clientId: "" },
    { revision: -1 },
    { revision: 1.5 },
    { body: " " },
    { body: "a".repeat(20_001) },
    { body: "a\0b" },
    { via: "assistant" },
  ])
    expect(EditMessageSchema.safeParse({ ...input, ...change }).success).toBe(false);
  expect(DeleteMessageSchema.safeParse(input).success).toBe(false);
});
