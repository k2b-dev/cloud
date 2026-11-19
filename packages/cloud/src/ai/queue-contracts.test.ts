import { expect, test } from "bun:test";
import { AiQueuedMessageSchema } from "./queue-contracts";

// Fictitious entry: an automation's message Cloud could not start yet and tries again by itself.
const entry = {
  id: "8b5f8c1e-2d3a-4c5b-8e6f-7a8b9c0d1e2f",
  text: "Mein Morgenbriefing: Termine und offene Angebote.",
  origin: { kind: "automation", id: "c_brief1", name: "Morgenbriefing", href: "/app/assistant/code/c_brief1" },
  state: "failed",
  createdAt: "2026-11-14T06:00:00.000Z",
  authorIsViewer: false,
  error: "dispatch_failed",
  retrying: true,
} as const;

test("a queued entry keeps why it failed and that Cloud retries, for every app that parses the shared schema", () => {
  expect(AiQueuedMessageSchema.parse(entry)).toEqual(entry);
  expect(AiQueuedMessageSchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  expect(AiQueuedMessageSchema.parse({ ...entry, state: "pending", error: null, retrying: false })).toMatchObject({
    error: null,
    retrying: false,
  });
  const { retrying: _retrying, ...withoutRetry } = entry;
  expect(AiQueuedMessageSchema.safeParse(withoutRetry).success).toBe(false);
});
