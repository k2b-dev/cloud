import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { aiCapabilities } from "../capabilities";
import { codeEventCatchupPumpConfig } from "./event-catchup";
import { codeEventTargetKey } from "./events";

const event = (id: string) => ({
  id: "00000000-0000-4000-8000-000000000001",
  type: "mail.message.received",
  version: 1,
  source: "mail",
  time: "2026-11-01T12:00:00Z",
  subject: { type: "mail.message", id },
  place: { type: "mail.mailbox", id: "Box123" },
  data: { receiptId: "00000000-0000-4000-8000-000000000002" },
});
const input = {
  operationId: "00000000-0000-4000-8000-000000000003",
  versionId: "00000000-0000-4000-8000-000000000004",
  codeId: "c_mail0001",
  requestDigest: "test",
  capacityDeadline: Date.parse("2026-11-01T12:00:00Z"),
  events: Array.from({ length: 45 }, (_, n) => event(`message${n}`)),
};
test("catch-up pull resumes a frozen bounded page without repeating earlier messages", async () => {
  const pull = codeEventCatchupPumpConfig.pull;
  const first = await pull({ input, cursor: null, limit: 20, signal: new AbortController().signal });
  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).toBe(20);
  const resumed = await pull({ input, cursor: first.nextCursor, limit: 20, signal: new AbortController().signal });
  expect(resumed.items[0]!.event.subject.id).toBe("message20");
  const last = await pull({ input, cursor: resumed.nextCursor, limit: 20, signal: new AbortController().signal });
  expect(last.items).toHaveLength(5);
  expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items, ...resumed.items, ...last.items].map((item) => item.key)).size).toBe(45);
});
test("cancellation stops dispatch before any database or run admission", async () => {
  await expect(
    codeEventCatchupPumpConfig.dispatch({ input, item: { key: "cancelled", event: input.events[0]! }, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});
test("historical identity pins version and message, independent of operation and envelope ID", () => {
  const original = codeEventTargetKey(input.versionId, input.events[0]!);
  expect(codeEventTargetKey(input.versionId, { ...input.events[0]!, id: input.operationId })).toBe(original);
  expect(codeEventTargetKey(input.operationId, input.events[0]!)).not.toBe(original);
});

test("historical identity survives JSONB subject-property ordering on live delivery", () => {
  const envelope = input.events[0]!;
  const fromJsonb = { ...envelope, subject: { id: envelope.subject.id, type: envelope.subject.type } };
  expect(JSON.stringify(fromJsonb.subject)).not.toBe(JSON.stringify(envelope.subject));
  expect(codeEventTargetKey(input.versionId, fromJsonb)).toBe(codeEventTargetKey(input.versionId, envelope));
});

test("Core publishes checked bounded event tool contracts", () => {
  const manifest = compileCapabilityManifest("core", aiCapabilities);
  expect(manifest.actions.find((action) => action.localId === "code.event.catchup")?.code).toBe(false);
});
