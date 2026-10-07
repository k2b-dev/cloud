import { expect, spyOn, test } from "bun:test";
import { artifactCodeHandlers } from "./code-tools";
import { artifactDatabase } from "./database";
import { CloudError } from "./runtime/errors";
import { testIdentity } from "./test-identity";

test("code_database returns managed-column errors as invalid results", async () => {
  const call = spyOn(artifactDatabase, "call").mockRejectedValue(
    new CloudError("invalid", "Cloud-managed columns cannot be dropped or renamed."),
  );
  try {
    expect(
      await artifactCodeHandlers.code_database(
        { id: "AbC234", operation: "tables.update", table: "invoices", changes: { drop_columns: ["created_by"] } },
        { ...testIdentity("11111111-1111-4111-8111-111111111111"), locale: "en", timeZone: "UTC", signal: new AbortController().signal },
      ),
    ).toEqual({ ok: false, error: { code: "INVALID_INPUT", status: 400, message: "Cloud-managed columns cannot be dropped or renamed." } });
  } finally {
    call.mockRestore();
  }
});

for (const [code, status, expected] of [
  ["denied", 403, "ACCESS_DENIED"],
  ["not_found", 404, "NOT_FOUND"],
  ["conflict", 409, "CONFLICT"],
  ["limit", 413, "LIMIT"],
  ["unavailable", 400, "unavailable"],
  ["cancelled", 400, "cancelled"],
] as const)
  test(`code_database returns ${code} as ${status}`, async () => {
    const call = spyOn(artifactDatabase, "call").mockRejectedValue(new CloudError(code, "Original message"));
    try {
      expect(
        await artifactCodeHandlers.code_database(
          { id: "AbC234", operation: "schema.get", table: "invoices" },
          { ...testIdentity("11111111-1111-4111-8111-111111111111"), locale: "en", timeZone: "UTC", signal: new AbortController().signal },
        ),
      ).toEqual({ ok: false, error: { code: expected, status, message: "Original message" } });
    } finally {
      call.mockRestore();
    }
  });
