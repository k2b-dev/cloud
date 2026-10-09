import { expect, test } from "bun:test";
import { aiCapabilityToolName } from "./capabilities";
import { buildBlocksFromMessages } from "./protocol";

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
