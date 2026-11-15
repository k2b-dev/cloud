import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { memoryStore, nessi, type Provider } from "@k2b/nessi";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { person } from "../_internal/define-app.test-fixture";
import { defineCapabilities } from "../contracts/capabilities";
import { buildAiCapabilityCatalog, createAiToolResolver, createRunToolStore } from "./capabilities";
import { executeAiCapability } from "./capability-execution";
import { createChoiceCapabilityOrigin } from "./choices";
import { aiToolAudit } from "./tool-audit";
import { applyAiTurnPolicy } from "./turn-policy";

afterEach(() => mock.restore());

test("a server-authored pending choice Query runs through the capability path before inference, with mapped input and origin", async () => {
  const app = {
    appId: "art",
    appName: "Art",
    appIcon: "ti ti-box",
    appDescription: "Art",
    endpoint: "http://art:3000",
    manifest: compileCapabilities(
      "art",
      defineCapabilities({
        protocolVersion: 2,
        queries: {
          inspect: {
            title: "Inspect",
            description: "Inspect a category",
            input: z.strictObject({ category: z.string().describe("Category") }),
            data: z.strictObject({ inspected: z.boolean() }),
            openWorld: false,
            run: async () => ({ ok: true, data: { data: { inspected: true } } }),
          },
        },
      }),
    ).manifest,
  };
  const entry = buildAiCapabilityCatalog([app])[0]!;
  const choice = { callId: "choice-call", appId: "art", query: entry.name };
  const authority = {
    actor: { kind: "user" as const, user: person },
    accessSubject: { type: "user" as const, userId: person.id },
    credentialKind: "session" as const,
    scopes: [],
  };
  const store = memoryStore();
  await store.append({ role: "user", content: [{ type: "text", text: "Gewählt in Art: Jugendstil (cat_jug)" }] });
  await store.append({
    role: "assistant",
    content: [{ type: "tool_call", id: choice.callId, name: entry.providerName, args: { category: "cat_jug" } }],
  });
  const steps: string[] = [];
  const audit = spyOn(aiToolAudit, "noteCapabilityDispatch").mockImplementation(async () => {
    steps.push("audit");
  });
  const choiceOrigin = createChoiceCapabilityOrigin(choice, false);
  const tools = createAiToolResolver({
    conversationId: "conversation",
    actor: authority.actor,
    authority,
    listApps: async () => [{ id: "art", name: "Art", description: "Art", icon: "ti ti-box", routes: [], baseUrl: "http://art:3000" }],
    staticTools: [],
    store: createRunToolStore([entry.name]),
    listRegistry: async () => [app],
    execute: async (operation, args, context) =>
      executeAiCapability({
        conversationId: "conversation",
        turnId: "turn",
        authority,
        entry: operation,
        args,
        context,
        origin: choiceOrigin(operation, context.callId),
        dependencies: {
          dispatch: async (request) => {
            expect(request.origin).toBe("choice");
            expect(request.input).toEqual({ category: "cat_jug" });
            expect(request.authority).toEqual(authority);
            expect(request.request.signal.aborted).toBe(false);
            steps.push("query");
            return Response.json({ data: { inspected: true } });
          },
        },
      }),
  });
  const provider: Provider = {
    name: "choice-test",
    family: "openai-compatible",
    model: "fixture",
    contextWindow: 32_000,
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    stream: async function* (request) {
      steps.push("model");
      expect(request.messages.at(-1)).toMatchObject({ role: "tool_result", callId: choice.callId, result: { data: { inspected: true } } });
      yield { type: "usage", usage: { input: 10, output: 1, total: 11 }, finishReason: "stop" };
    },
  };
  const policy = applyAiTurnPolicy({
    provider,
    tools,
    maxToolRounds: 1,
    issuedToolRounds: 1,
    completedToolRounds: 0,
    deadline: null,
    runBudgetMs: null,
  });
  for await (const event of nessi({ loopId: "turn", store, provider: policy.provider, tools: policy.tools, systemPrompt: "Test" })) {
    if (event.type === "turn_end") policy.noteToolRound();
  }
  expect(steps).toEqual(["audit", "query", "model"]);
  expect(audit).toHaveBeenCalledTimes(1);
  expect(choiceOrigin(entry, "model-call")).toBeUndefined();
  // Even reuse of the visible call id by a later model call cannot acquire Choice provenance.
  expect(choiceOrigin(entry, choice.callId)).toBeUndefined();
  expect(createChoiceCapabilityOrigin(choice, true)(entry, choice.callId)).toBeUndefined();
  expect(createChoiceCapabilityOrigin(choice, false)({ ...entry, kind: "action" }, choice.callId)).toBeUndefined();
});
