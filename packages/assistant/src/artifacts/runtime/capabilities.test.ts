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

test("a background host approval refusal reaches sandbox code with its exact message", async () => {
  const message =
    "NEEDS_APPROVAL: Create task needs the user's approval every time, and routines never ask. Stop and say in one sentence what was missing.";
  const prepare = spyOn(artifactClient, "capabilityPrepare").mockRejectedValue(
    Object.assign(new Error(message), { code: "NEEDS_APPROVAL" }),
  );
  const resolve = spyOn(artifactClient, "capabilityResolve");
  try {
    await expect(
      runCapability(
        "demo.write",
        {},
        {},
        async () => {
          throw new Error("Unexpected approval");
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NEEDS_APPROVAL", message });
    expect(resolve).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    resolve.mockRestore();
  }
});

test("SDK coordinates and idempotency metadata retain the existing action approval flow", async () => {
  const options = { target: { type: "example.box", id: "box_fixture" }, refs: {}, idempotencyKey: "weekly:2030-01-07" };
  const prepare = spyOn(artifactClient, "capabilityPrepare").mockResolvedValue({
    status: "approval",
    id: "11111111-1111-4111-8111-111111111111",
    title: "Create item",
    allowAlways: false,
    appId: "example",
    localId: "item.create",
    kind: "action",
    schemaHash: "fixture",
    approval: "rememberable",
    review: null,
    scope: null,
    name: "example.item.create",
    input: { title: "Weekly review" },
    appName: "Example",
    appIcon: "ti ti-box",
  });
  const resolve = spyOn(artifactClient, "capabilityResolve").mockResolvedValue({
    status: "completed",
    result: { ok: true, data: { data: { id: "item_fixture" } } },
  });
  let approvals = 0;
  try {
    const result = await runCapability(
      "example.item.create",
      { title: "Weekly review" },
      { conversationId: "chat_fixture" },
      async () => {
        approvals++;
        return { approved: true };
      },
      new AbortController().signal,
      options,
    );
    expect(approvals).toBe(1);
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({ ...options, name: "example.item.create", input: { title: "Weekly review" } });
    expect(resolve.mock.calls[0]?.[1]).toEqual({ approved: true });
    expect(result).toEqual({ data: { id: "item_fixture" } });
  } finally {
    prepare.mockRestore();
    resolve.mockRestore();
  }
});
