import { expect, spyOn, test } from "bun:test";
import { artifactClient } from "../client";
import { runCapability } from "./capabilities";

test("capabilities.run preserves the public domain-data and reference envelope", async () => {
  const envelope = { data: { answer: 42 }, refs: [{ type: "example.record", id: "one" }] };
  const prepare = spyOn(artifactClient, "capabilityPrepare").mockResolvedValue({
    status: "completed",
    result: { ok: true, data: envelope },
  });
  try {
    const result = await runCapability(
      "example.read",
      {},
      {},
      async () => {
        throw new Error("Read must not need approval");
      },
      new AbortController().signal,
    );
    expect(result).toEqual(envelope);
  } finally {
    prepare.mockRestore();
  }
});

for (const [response, code, message] of [
  [{ status: "denied" }, "denied", "Capability Action was rejected by the user."],
  [{ status: "completed", result: { ok: false, error: { code: "NOT_FOUND", message: "Missing record" } } }, "not_found", "Missing record"],
  [{ status: "completed", result: null }, "unavailable", "Invalid capability result"],
] as const)
  test(`capability failures preserve ${code}`, async () => {
    const prepare = spyOn(artifactClient, "capabilityPrepare").mockResolvedValue(response);
    try {
      await expect(
        runCapability("example.read", {}, {}, async () => ({ approved: false }), new AbortController().signal),
      ).rejects.toMatchObject({ name: "CloudError", code, message });
    } finally {
      prepare.mockRestore();
    }
  });
