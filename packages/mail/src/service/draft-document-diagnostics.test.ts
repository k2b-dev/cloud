import { expect, test } from "bun:test";
import { ConflictError } from "@k2b/sync";
import { draftDocumentDiagnostics, draftTraceSocketSend, draftTraceSpan, draftUpdateId } from "./draft-document-diagnostics";

test("publication diagnostics distinguish a durable acknowledgement from a rejected CAS without swallowing the error", async () => {
  const events: unknown[] = [];
  const listener = (event: unknown) => events.push(event);
  draftDocumentDiagnostics.subscribe(listener);
  const conflict = new ConflictError("document head changed");
  try {
    await expect(
      draftTraceSpan("jetstream_publish_ack", async () => {
        throw conflict;
      }),
    ).rejects.toBe(conflict);
    expect(events.at(-1)).toMatchObject({ stage: "jetstream_publish_ack:end", outcome: "error", errorName: "ConflictError" });
    expect(await draftTraceSpan("jetstream_publish_ack", async () => "retained")).toBe("retained");
    expect(events.at(-1)).toMatchObject({ stage: "jetstream_publish_ack:end", outcome: "ok" });
  } finally {
    draftDocumentDiagnostics.unsubscribe(listener);
  }
});

test("socket diagnostics identify each live update and receiver without retaining document payloads", () => {
  // A disabled diagnostic must not even decode its input.
  expect(() => draftTraceSocketSend("not JSON", "receiver")).not.toThrow();
  const events: unknown[] = [];
  const listener = (event: unknown) => events.push(event);
  const payload = "AQID";
  const packet = {
    type: "syncPush",
    payload: { docId: "abc123", generation: "1", updates: [{ payload, generation: "1", originPeerId: "sender" }] },
  };
  draftDocumentDiagnostics.subscribe(listener);
  try {
    draftTraceSocketSend(JSON.stringify(packet), "receiver");
    expect(events).toEqual([
      expect.objectContaining({
        stage: "peer_send",
        updateId: draftUpdateId(payload),
        peerId: "receiver",
        originPeerId: "sender",
        role: "delivery",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("payload");
    draftTraceSocketSend(JSON.stringify({ ...packet, payload: { ...packet.payload, snapshot: true } }), "receiver");
    expect(events).toHaveLength(1);
  } finally {
    draftDocumentDiagnostics.unsubscribe(listener);
  }
});
