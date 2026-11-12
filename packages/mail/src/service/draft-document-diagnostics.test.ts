import { expect, test } from "bun:test";
import {
  draftDocumentDiagnostics,
  draftTrace,
  draftTraceContext,
  draftTraceError,
  draftTraceSpan,
  withDraftTrace,
} from "./draft-document-diagnostics";

test("opt-in edit traces preserve concurrent contexts without retaining payloads", async () => {
  expect(draftTraceContext("cHJpdmF0ZS1lZGl0", "off", "ingress")).toBeUndefined();
  const events: unknown[] = [];
  const listener = (event: unknown) => events.push(event);
  draftDocumentDiagnostics.subscribe(listener);
  try {
    const barrier = Promise.withResolvers<void>();
    await Promise.all(
      ["a", "b"].map((peerId) =>
        withDraftTrace(draftTraceContext("cHJpdmF0ZS1lZGl0", peerId, "ingress"), async () => {
          await draftTraceSpan("query", async () => {
            if (peerId === "b") barrier.resolve();
            await barrier.promise;
            draftTrace("after_wait");
          });
        }),
      ),
    );
    expect(events).toHaveLength(6);
    for (const peerId of ["a", "b"]) {
      expect(
        events.filter((event) => typeof event === "object" && event !== null && "peerId" in event && event.peerId === peerId),
      ).toHaveLength(3);
    }
    expect(JSON.stringify(events)).not.toContain("private-edit");
    expect(JSON.stringify(events)).not.toContain("cHJpdmF0ZS1lZGl0");
  } finally {
    draftDocumentDiagnostics.unsubscribe(listener);
  }
  expect(draftTraceContext("cHJpdmF0ZS1lZGl0", "off", "ingress")).toBeUndefined();
});

test("failed spans record completion and structured error codes", async () => {
  const events: unknown[] = [];
  const listener = (event: unknown) => events.push(event);
  draftDocumentDiagnostics.subscribe(listener);
  try {
    const error = Object.assign(new Error("fixture failure"), { code: "57014" });
    await expect(
      draftTraceSpan("query", async () => {
        throw error;
      }),
    ).rejects.toThrow("fixture failure");
    draftTraceError(error, "delivery-sql");
    expect(events).toMatchObject([
      { stage: "query:start" },
      { stage: "query:end" },
      { stage: "failure", source: "delivery-sql", error: { name: "Error", message: "fixture failure", code: "57014" } },
    ]);
  } finally {
    draftDocumentDiagnostics.unsubscribe(listener);
  }
});
