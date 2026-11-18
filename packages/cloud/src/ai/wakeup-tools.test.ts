import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { userResourceContext } from "./projects.test-fixture";
import { createAiWakeupTools } from "./wakeup-tools";
import { aiWakeups } from "./wakeups";
import type { AiChatTurnRunConfig } from "./types";

const identity = userResourceContext({ type: "user", userId: "5b000000-0000-4000-8000-000000000001" });
const config: AiChatTurnRunConfig = {
  kind: "chat", input: "Erinnere mich", actor: identity.actor, assistantChat: true,
  turnTrigger: { kind: "person", id: "5b000000-0000-4000-8000-000000000001" }, toolSource: { kind: "default" }, locale: "de",
};
const turnId = "5b000000-0000-4000-8000-000000000003";
afterEach(() => mock.restore());

test("alarms are scoped server tools with no approval or caller-chosen destination", () => {
  const tools = createAiWakeupTools(config, "Ab3dEf", turnId, null);
  expect(tools.map((tool) => tool.def.name)).toEqual(["wakeup_create", "wakeup_list", "wakeup_update", "wakeup_delete"]);
  for (const tool of tools) {
    expect(tool.location).toBe("server");
    expect(tool.def.approval).toBe("never");
    expect(tool.def.inputSchema.safeParse({ conversationId: "Other" }).success).toBe(false);
  }
});

test("restricted sources cannot discover alarm tools", () => {
  const restricted: AiChatTurnRunConfig[] = [
    { ...config, sourceRestricted: true }, { ...config, toolSource: { kind: "none" } }, { ...config, assistantChat: undefined },
    { ...config, mandate: { id: "mandate", revision: 1 } }, { ...config, codeReview: { codeId: "c_test", versionId: turnId } },
    { ...config, turnTrigger: { kind: "automation", id: "c_test" } }, { ...config, turnTrigger: { kind: "chat", id: "Other" } },
    { ...config, turnTrigger: undefined },
  ];
  if (identity.actor.kind === "user") restricted.push({ ...config, actor: { ...identity.actor, sessionKind: "app" } });
  for (const entry of restricted) expect(createAiWakeupTools(entry, "Ab3dEf", turnId, null)).toEqual([]);
  expect(createAiWakeupTools(config, "Ab3dEf", turnId, [])).toEqual([]);
});

test("the tool reaches the permission-aware service with runtime chat, actor and turn identity", async () => {
  const list = spyOn(aiWakeups, "list").mockResolvedValue({ items: [], limit: 5, paused: false });
  const tool = createAiWakeupTools(config, "Ab3dEf", turnId, null).find((entry) => entry.def.name === "wakeup_list");
  if (tool?.location !== "server") throw new Error("List tool missing");
  await tool.run({}, { signal: new AbortController().signal, callId: "call", actor: identity.actor, requestApproval: async () => false, requestClientTool: async () => { throw new Error("No client"); } });
  expect(list).toHaveBeenCalledWith("Ab3dEf", { ...identity, turnId }, "de");
});
