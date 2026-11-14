import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { createCodeTestBridge, generateCodeSdk } from "@k2b/cloud/code";
import { z } from "zod";
import { TaskDataSchema } from "./capability-contracts";

// The complete reply shape from the reported failure, with fictional Space identity.
const reply = {
  kind: "task",
  id: "Itm0001",
  spaceId: "Spc001",
  columnId: "ColBacklog01",
  title: "Weekly review",
  titleTruncated: false,
  description: null,
  descriptionTruncated: false,
  completedAt: null,
  assignees: [],
  tags: [],
  relationsTruncated: false,
  createdAt: "2026-11-20T15:00:00Z",
  updatedAt: "2026-11-20T15:00:00Z",
  deadline: null,
  deadlineAllDay: false,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
};
const operation = "spaces.task.create";
const target = { type: "spaces.space", id: "Spc001" };
// Project the owning application's real data schema through a normal provider manifest.
const manifest = generateCodeSdk(
  [
    compileCapabilityManifest("spaces", {
      protocolVersion: 2,
      types: { space: { title: "Space", description: "A fictional Space." } },
      actions: {
        "task.create": {
          title: "Create task",
          description: "Create a fictional task.",
          target: "space",
          openWorld: false,
          destructive: false,
          idempotency: "required",
          input: z.object({ title: z.string().describe("Task title.") }).strict(),
          data: TaskDataSchema,
          run: () => {
            throw new Error("must not call a real service");
          },
        },
      },
    }),
  ],
  { mode: "personal" },
).manifest;
const invocation = {
  call: { capability: operation, target, refs: {}, input: { title: "Weekly review" } },
  metadata: { idempotencyKey: "weekly:2026-11-20" },
};

test("a rejected Spaces reply names each invalid ID and accepts the corrected schema-valid fixture", async () => {
  for (const [data, field] of [
    [reply, "id"],
    [{ ...reply, id: "Itm001" }, "columnId"],
  ] as const) {
    expect(TaskDataSchema.safeParse(data).success).toBe(false);
    const bridge = createCodeTestBridge(manifest, [{ operation, target, replies: [{ ok: true, data }] }]);
    await expect(bridge.call(operation, invocation)).rejects.toThrow("code_test_invalid_fixture");
    expect(bridge.calls()[0]?.result).toMatchObject({
      detail: {
        operation,
        mockIndex: 0,
        replyIndex: 0,
        path: ["mocks", 0, "replies", 0, "data", field],
        reason: expect.stringContaining("[0-9A-Za-z]{6}"),
      },
    });
  }
  const corrected = { ...reply, id: "Itm001", columnId: "Col001" };
  expect(TaskDataSchema.safeParse(corrected).success).toBe(true);
  const bridge = createCodeTestBridge(manifest, [{ operation, target, replies: [{ ok: true, data: corrected }] }]);
  expect(await bridge.call(operation, invocation)).toEqual(corrected);
  expect(await bridge.call(operation, invocation)).toEqual(corrected);
  expect(bridge.calls()[1]?.replayed).toBe(true);
});
