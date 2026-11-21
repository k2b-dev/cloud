import { describe, expect, test } from "bun:test";
import { IngestBatchSchema } from "../api/schemas";
import { REJECTION_REASON_MAX_LENGTH, schemaRejectionReason, serviceRejectionReason } from "./source-rejection-reason";

const reasonFor = (batch: unknown): string => {
  const result = IngestBatchSchema.safeParse(batch);
  if (result.success) throw new Error("Expected the batch to be refused");
  return schemaRejectionReason(result.error.issues);
};

describe("Pulse source rejection reasons", () => {
  test("names the first failing path with the schema rule", () => {
    const events = [{ kind: "a" }, { kind: "b" }, { kind: "c" }, { kind: "d", attributes: "secret-token-123" }];
    expect(reasonFor({ events })).toBe("events[3].attributes: expected record");
    expect(reasonFor({ metrics: [{ name: "cpu", value: "high" }] })).toBe("metrics[0].value: expected number");
    expect(reasonFor({ metrics: [{ name: "", value: 1 }] })).toBe("metrics[0].name: must not be empty");
    expect(reasonFor({ metrics: [{ name: "cpu", value: 1, type: "histogram" }] })).toBe("metrics[0].type: not an allowed value");
    expect(reasonFor({ states: [{ key: "door", value: true, sourceId: "x" }] })).toBe("states[0].sourceId: field not allowed");
    expect(reasonFor({ events: [{ kind: "a", ts: "yesterday" }] })).toBe("events[0].ts: invalid datetime");
  });

  test("never echoes sender values or sender keys", () => {
    const secret = "sk_live_4f9a8b7c";
    const reasons = [
      reasonFor({ events: [{ kind: "a", [secret]: 1 }] }),
      reasonFor({ metrics: [{ name: "cpu", value: 1, dimensions: { [secret]: { nested: secret } } }] }),
      reasonFor({ [secret]: [] }),
      reasonFor({ events: [{ kind: "a", actorId: { value: secret } }] }),
    ];
    for (const reason of reasons) expect(reason).not.toContain(secret);
    expect(reasons[0]).toBe("events[0]: unknown field");
    expect(reasons[1]).toBe("metrics[0].dimensions.*: does not match an allowed type");
  });

  test("keeps Pulse's own refinement text and bounds every reason", () => {
    expect(reasonFor({ events: [{ kind: "a", resource: { type: "Bad Type", id: "1" } }] })).toBe(
      "events[0].resource: Resource type must be a lowercase slug",
    );
    const long = schemaRejectionReason([{ code: "custom", message: "x".repeat(1_000), path: ["events", 0, "payload"] }]);
    expect(long).toHaveLength(REJECTION_REASON_MAX_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    expect(schemaRejectionReason([])).toBe("Invalid ingest batch");
  });

  test("service refusals mask names, keys, and timestamps from the batch", () => {
    expect(
      serviceRejectionReason(
        'metrics[3] (name "billing.customer.4711") has timestamp 2026-11-21T12:00:00.000Z, more than 5 minutes in the future',
      ),
    ).toBe("metrics[3] (name “…”) has timestamp …, more than 5 minutes in the future");
    expect(serviceRejectionReason('Event kind "signup:max@example.org" exceeds the base limit of 1000 event kinds')).toBe(
      "Event kind “…” exceeds the base limit of 1000 event kinds",
    );
    expect(
      serviceRejectionReason(
        "Metric user email max@example.org exceeds the limit of 10000 series. Move high-cardinality values to events or reduce metric dimensions.",
      ),
    ).toBe("Metric … exceeds the limit of 10000 series. Move high-cardinality values to events or reduce metric dimensions.");
    expect(serviceRejectionReason("Pulse base is throttled. Retry after the indicated delay.")).toBe(
      "Pulse base is throttled. Retry after the indicated delay.",
    );
    expect(serviceRejectionReason("y".repeat(400))).toHaveLength(REJECTION_REASON_MAX_LENGTH);
  });
});
