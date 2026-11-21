import { expect, test } from "bun:test";
import { VersionListSchema } from "./data";

// Core and the shared page evolve together: one terminal version must never invalidate the whole history.
test("version history accepts every Code decision and lifecycle state", () => {
  for (const status of [
    "submitted",
    "pending",
    "approved",
    "changes_requested",
    "rejected",
    "withdrawn",
    "superseded",
    "expired",
    "cancelled",
  ] as const) {
    const result = VersionListSchema.parse({
      items: [
        {
          version: { id: "version", number: 2, createdBy: null, createdAt: "2026-11-14T12:00:00.000Z" },
          status,
          decision: null,
        },
      ],
      nextBefore: null,
    });
    expect(result.items[0]?.status).toBe(status);
  }
});
