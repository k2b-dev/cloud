import { expect, test, spyOn } from "bun:test";
import { defineTool, nessi, type Provider, type StoreEntry, type InboundEvent } from "@k2b/nessi";
import { z } from "zod";
import { aiConversations } from "./store";
import { runManagedCodeTool, waitForManagedCodeCall } from "./code-runtime-tools";

test("two managed approvals retain their Nessi action IDs across two suspended attempts", async () => {
  const entries: StoreEntry[] = [];
  const approvals = [
    { id: "11111111-1111-4111-8111-111111111111", message: "First HTTP request", decision: null as boolean | null },
    { id: "22222222-2222-4222-8222-222222222222", message: "Second HTTP request", decision: null as boolean | null },
  ];
  const decisions: string[] = [];
  const tool = defineTool({ name: "code_run", description: "Run", inputSchema: z.object({}) }).server(async (_input, context) =>
    waitForManagedCodeCall(async (decision) => {
      if (decision) {
        const approval = approvals.find((item) => item.id === decision.id)!;
        expect(approval.decision).toBeNull();
        approval.decision = decision.approved;
        decisions.push(decision.id);
      }
      const done = approvals.every((item) => item.decision !== null);
      return {
        status: done ? "done" : "running",
        result: done ? { executed: 1 } : undefined,
        approvals: approvals.slice(0, approvals[0]!.decision === null ? 1 : 2).map((item) => ({ ...item })),
      };
    }, context),
  );
  let requests = 0;
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    async complete() {
      throw new Error("Unexpected completion");
    },
    async *stream() {
      requests++;
      if (requests === 1) {
        yield { type: "block_start", blockId: "run", index: 0, kind: "tool_call", callId: "run", name: "code_run" };
        yield { type: "block_end", blockId: "run", index: 0, block: { type: "tool_call", id: "run", name: "code_run", args: {} } };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
      } else {
        yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
        yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
      }
    },
  };
  const responses: InboundEvent[] = [];
  const actionIds: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const loop = nessi({
      loopId: "managed-loop",
      provider,
      systemPrompt: "",
      tools: [tool],
      maxTurns: 3,
      ...(attempt === 0 ? { input: "Run" } : {}),
      store: {
        load: async () => entries,
        append: async (message) => {
          entries.push({ seq: entries.length + 1, kind: "message", message });
        },
      },
    });
    for (const response of responses) loop.push(response);
    for await (const event of loop) {
      if (event.type === "tool_action_request") {
        expect(event.kind).toBe("custom_approval");
        expect(actionIds).not.toContain(event.callId);
        actionIds.push(event.callId);
        responses.push({ type: "approval_response", callId: event.callId, approved: true });
        break;
      }
    }
  }
  expect(actionIds).toHaveLength(2);
  expect(decisions).toEqual(approvals.map((item) => item.id));
  expect(requests).toBe(2);
  expect(
    entries.some((entry) => entry.message.role === "tool_result" && JSON.stringify(entry.message.result).includes('"executed":1')),
  ).toBe(true);
});

test("managed code rejects background authority before resolving a user or contacting a host", async () => {
  const actor = {
    kind: "user" as const,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      uid: "test",
      provider: "local" as const,
      profile: "user" as const,
      displayName: "Test",
      mail: "test@example.test",
      givenname: "Test",
      sn: "User",
      roles: ["user" as const],
      accountExpires: null,
      avatarHash: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    },
  };
  const config = spyOn(aiConversations, "getTurnRunConfig");
  try {
    for (const runConfig of [
      null,
      { input: "Run", mandate: { id: crypto.randomUUID(), revision: 1 } },
      { input: "Run", background: { taskId: "task01", occurrenceId: "run001", context: [] } },
    ]) {
      config.mockResolvedValue(runConfig);
      await expect(
        runManagedCodeTool("code_run")(
          {},
          {
            actor,
            conversationId: "chat",
            turnId: "turn",
            signal: AbortSignal.timeout(1000),
            requestApproval: async () => {
              throw new Error("Unexpected approval");
            },
            requestClientTool: async <T>(): Promise<T> => {
              throw new Error("Unexpected client");
            },
          },
        ),
      ).rejects.toThrow("task-scoped authority");
    }
  } finally {
    config.mockRestore();
  }
});
