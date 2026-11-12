import { expect, test } from "bun:test";
import { ConflictError } from "@k2b/sync";
import { draftDocumentDiagnostics, draftTraceSpan } from "./draft-document-diagnostics";

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
