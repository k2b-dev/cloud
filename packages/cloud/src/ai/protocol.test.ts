import { expect, test } from "bun:test";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
import type { AiStoredActionReview } from "./action-review";
import { aiCapabilityToolName } from "./capabilities";
import { buildBlocksFromMessages } from "./protocol";

test.each(["completed", "failed", "rejected"] as const)("rebuilds the %s outcome time from the tool result", (status) => {
  const createdAt = "2026-10-07T10:23:45.000Z";
  const call = {
    seq: 1,
    createdAt: "2026-10-07T10:00:00.000Z",
    message: { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "call", name: "send", args: {} }] },
  };
  expect(buildBlocksFromMessages([call])[0]).not.toHaveProperty("at");
  const result = {
    seq: 2,
    message: { role: "tool_result" as const, callId: "call", name: "send", result: {}, isError: status !== "completed" },
    meta: status === "rejected" ? { toolOutcomes: { call: "rejected" as const } } : null,
  };
  expect(buildBlocksFromMessages([call, result])[0]).not.toHaveProperty("at");
  expect(buildBlocksFromMessages([call, { ...result, createdAt }])[0]).toMatchObject({ status, at: createdAt });
});

const rebuiltName = (name: string) => {
  const message = { role: "assistant" as const, content: [{ type: "tool_call" as const, id: "call", name, args: {} }] };
  const blocks = buildBlocksFromMessages([{ seq: 1, message }]);
  expect(message.content[0]!.name).toBe(name);
  const block = blocks[0];
  if (block?.kind !== "tool") throw new Error("Expected tool");
  return block.name;
};
test.each([
  ["spaces", "task.create"],
  ["custom_app", "task_id.create"],
  ["custom/app", "list items"],
  ["a._u20_", "🦊._dot_"],
  ["app", "_u110000_"],
])("rebuilt capability blocks decode %s.%s while messages retain provider names", (appId, localId) => {
  for (const kind of ["query", "action"] as const)
    expect(rebuiltName(aiCapabilityToolName(appId, kind, localId))).toBe(`${appId}.${localId}`);
});
test.each([
  "code_open",
  "survey",
  "spaces.task.create",
  "spaces__other__task",
  "spaces__action__bad_escape",
  "a____query____b__query__task____action____id",
  "spaces__action__bad_u110000_",
  "spaces__action__bad_u2e_",
  "spaces__action__bad_u5f_",
  "spaces__action__bad_u61_",
  "spaces__action__bad_u020_",
  aiCapabilityToolName("spaces", "action", `task.${"nested".repeat(20)}`),
])("leaves built-in, malformed, and hashed names unchanged: %s", (name) => {
  expect(rebuiltName(name)).toBe(name);
});

test("persisted presentation app ID disambiguates escaped delimiter words", () => {
  const name = aiCapabilityToolName("custom_query_app", "action", "task_action_create");
  const blocks = buildBlocksFromMessages([
    {
      seq: 1,
      message: { role: "assistant", content: [{ type: "tool_call", id: "call", name, args: {} }] },
      meta: {
        toolPresentations: {
          call: {
            kind: "capability",
            appId: "custom_query_app",
            appName: "Custom",
            appIcon: "",
            title: "Create",
            capabilityKind: "action",
          },
        },
      },
    },
  ]);
  expect(blocks[0]).toMatchObject({ name: "custom_query_app.task_action_create" });
});

test.each<AiStoredActionReview>([reviewFixture(), { legacy: { question: "Send the original draft?", rows: [] } }])(
  "restores the stored review and check through a completed result",
  (review) => {
    const check = { state: "done" as const, receipt: { text: "Queued" }, at: "2026-10-18T09:00:00.000Z" };
    const blocks = buildBlocksFromMessages([
      {
        seq: 1,
        message: { role: "assistant", content: [{ type: "tool_call", id: "send", name: "demo.send", args: {} }] },
        meta: { toolReviews: { send: review }, toolChecks: { send: check } },
      },
      { seq: 2, message: { role: "tool_result", callId: "send", name: "demo.send", result: { data: null }, isError: false } },
    ]);
    expect(blocks[0]).toMatchObject({ status: "completed", review, check });
  },
);
