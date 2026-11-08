import { afterEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { type Message, memoryStore, nessi, type OutboundEvent, type Provider, type ToolContext } from "@k2b/nessi";
import { z } from "zod";
import { adminAuthority } from "../../../../scripts/fixtures/app-status";
import {
  createAssistantPlaceFixture,
  PLACE_FIXTURE_APP_ID,
  PLACE_FIXTURE_PEOPLE,
  PLACE_FIXTURE_TYPE,
} from "../../../../scripts/fixtures/assistant-place";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { compileCapabilities, invokeCompiledCapability, reviewCompiledCapability } from "../_internal/capabilities";
import { dispatchCapability } from "../api/capabilities";
import { capabilityCallFromTool, capabilityToolInputSchema } from "../capabilities/calls";
import * as executions from "../capabilities/executions";
import type { RequestAuthority } from "../server";
import * as categories from "../services/account-category-policy";
import { buildAiCapabilityCatalog, createAiToolResolver, createLoadedAiCapabilityTools, createRunToolStore } from "./capabilities";
import { executeAiCapability, reviewAiCapability } from "./capability-execution";
import { __aiExecutorTest } from "./executor";
import { rejectUnavailablePlaceCalls, resolveAiPlaceTools } from "./place-tools";
import { prepareAiTools } from "./tools";
import type { AiConversation } from "./types";

useUnitClients();
afterEach(() => {
  mock.restore();
  setSystemTime();
});
const ref = { type: PLACE_FIXTURE_TYPE, id: "marta" };
const harness = () => {
  const fixture = createAssistantPlaceFixture();
  const compiled = compileCapabilities(PLACE_FIXTURE_APP_ID, fixture.capabilities);
  const app = {
    appId: PLACE_FIXTURE_APP_ID,
    appName: "Contact fixture",
    appDescription: "Invented",
    appIcon: "ti ti-message",
    endpoint: "http://fixture.test",
    manifest: compiled.manifest,
  };
  const base = adminAuthority();
  if (base.actor.kind !== "user") throw new Error("Missing user");
  const person = { ...base.actor.user, id: PLACE_FIXTURE_PEOPLE.lea };
  const authority: RequestAuthority & { actor: Extract<RequestAuthority["actor"], { kind: "user" }> } = {
    ...base,
    actor: { kind: "user", user: person },
    accessSubject: { type: "user", userId: person.id },
  };
  const conversation: AiConversation = {
    id: "chat",
    shortId: "abc123",
    title: "Marta",
    titleSource: "default",
    description: "",
    descriptionSource: "default",
    keywords: [],
    pinnedAt: null,
    done: null,
    isDone: false,
    lastUsedAt: "2026-11-08T00:00:00Z",
    archivedAt: null,
    runStatus: "idle",
    runError: null,
    unreadCompletion: false,
    projectId: null,
    draft: { content: [], revision: 0, updatedAt: null },
    createdByUserId: person.id,
    createdAt: "2026-11-08T00:00:00Z",
    updatedAt: "2026-11-08T00:00:00Z",
    place: { ref, title: "Marta" },
  };
  let active = true;
  spyOn(categories, "isAccountCategoryAllowed").mockResolvedValue(true);
  spyOn(executions, "recordCapabilityExecution").mockResolvedValue("execution");
  const dispatch = mock<typeof dispatchCapability>(async (params) => {
    const invoke = params.review ? reviewCompiledCapability : invokeCompiledCapability;
    const result = await invoke({
      compiled,
      kind: params.kind === "queries" ? "query" : "action",
      localId: params.capabilityId,
      input: params.input,
      target: params.target,
      expectedSchemaHash: (params.kind === "queries" ? compiled.queries : compiled.actions).get(params.capabilityId)!.manifest.schemaHash,
      context: {
        actor: params.authority!.actor,
        user: authority.actor.user,
        authority: params.authority!,
        accessSubject: params.authority!.accessSubject,
        requestId: "fixture",
        locale: "en",
        origin: "assistant",
        signal: params.request.signal,
      },
    });
    return result.ok ? Response.json(result.data) : Response.json(result.error, { status: result.error.status });
  });
  let consent = true;
  const place = {
    getConsent: async () => ({ allowed: consent, revision: 1 }),
    store: { getConversation: async () => conversation },
    getUser: async () => (active ? person : null),
    providerOptions: { dependencies: { getCapability: async () => app, dispatch } },
  };
  const entry = buildAiCapabilityCatalog([app], "en", { ref, tools: ["reply.set", "note.add"] }).find(
    (x) => x.operation.localId === "reply.set",
  )!;
  const context: ToolContext = {
    callId: "call",
    signal: new AbortController().signal,
    requestApproval: async () => true,
    requestClientTool: async () => {
      throw new Error("No client");
    },
  };
  const call = {
    conversationId: "chat",
    authority,
    entry,
    args: { text: "Hello", conversation: "jonas" },
    context,
    dependencies: { dispatch, place },
  };
  return {
    ...fixture,
    app,
    entry,
    authority,
    conversation,
    place,
    context,
    call,
    dispatch,
    revokeConsent: () => {
      consent = false;
    },
    deactivate: () => {
      active = false;
    },
  };
};

test("place schema hides the target and conversion pins it while keeping explicit refs", () => {
  const h = harness();
  const operation = { ...h.entry.operation, refs: { related: "conversation" } };
  expect(capabilityToolInputSchema(operation, ref).properties).toEqual({ text: expect.anything(), related: expect.anything() });
  expect(
    capabilityCallFromTool(PLACE_FIXTURE_APP_ID, operation, { text: "Hi", conversation: "jonas", related: "jonas" }, ref),
  ).toMatchObject({ target: ref, input: { text: "Hi" }, refs: { related: { type: PLACE_FIXTURE_TYPE, id: "jonas" } } });
  expect(() => capabilityCallFromTool("another", operation, { text: "Hi", related: "jonas" }, ref)).toThrow();
});

test("approval snapshots use the same fixed target as execution", () => {
  const h = harness();
  expect(__aiExecutorTest.capabilityApprovalArgs(h.entry, { text: "Hi" })).toMatchObject({ target: ref, input: { text: "Hi" } });
});

test("general catalog excludes place actions; only the matching current subset is offered", () => {
  const h = harness();
  expect(buildAiCapabilityCatalog([h.app]).filter((x) => x.kind === "action")).toEqual([]);
  const entries = buildAiCapabilityCatalog([h.app], "en", { ref, tools: ["reply.set", "outside"] }).filter((x) => x.kind === "action");
  expect(entries.map((x) => x.name)).toEqual([`${PLACE_FIXTURE_APP_ID}.reply.set`]);
  expect(entries[0]!.place).toEqual(ref);
  expect(
    buildAiCapabilityCatalog([h.app], "en", { ref: { ...ref, type: "other.conversation" }, tools: ["reply.set"] }).filter(
      (x) => x.kind === "action",
    ),
  ).toEqual([]);
});

test("every dispatch reads fresh permissions and ignores a model's other conversation", async () => {
  const h = harness();
  await executeAiCapability(h.call);
  expect(h.calls).toEqual([{ person: PLACE_FIXTURE_PEOPLE.lea, target: "marta", text: "Hello" }]);
  h.permissions.delete(`${PLACE_FIXTURE_PEOPLE.lea}:marta`);
  await expect(executeAiCapability(h.call)).rejects.toMatchObject({ code: "PLACE_REJECTED" });
  expect(h.calls).toHaveLength(1);
  expect(h.providerCalls).toEqual(["marta", "marta"]);
});

test("read-only, inactive and foreign-owner chats reject forced place calls", async () => {
  const h = harness();
  h.permissions.set(`${PLACE_FIXTURE_PEOPLE.lea}:marta`, "read");
  expect(await resolveAiPlaceTools({ conversationId: "chat", actor: h.authority.actor, dependencies: h.place })).toEqual({
    ref,
    tools: [],
  });
  await expect(executeAiCapability(h.call)).rejects.toMatchObject({ code: "PLACE_REJECTED" });
  h.permissions.set(`${PLACE_FIXTURE_PEOPLE.lea}:marta`, "write");
  h.deactivate();
  await expect(executeAiCapability(h.call)).rejects.toMatchObject({ code: "PLACE_REJECTED" });
  expect(h.calls).toEqual([]);
  const other = harness();
  other.conversation.createdByUserId = PLACE_FIXTURE_PEOPLE.ben;
  await expect(executeAiCapability(other.call)).rejects.toMatchObject({ code: "PLACE_REJECTED" });
  expect(other.providerCalls).toEqual([]);
});

test("approval uses the ordinary policy, then checks again after the person answers", async () => {
  const h = harness();
  const rejected = mock(() => {});
  const entry = buildAiCapabilityCatalog([h.app], "en", { ref, tools: ["note.add"] }).find((x) => x.operation.localId === "note.add")!;
  const tool = createLoadedAiCapabilityTools({
    apps: [h.app],
    catalog: [entry],
    loadedNames: [entry.name],
    actor: h.authority.actor,
    review: (entry, args, context) => reviewAiCapability({ ...h.call, entry, args, context }),
    execute: (entry, args, context) => executeAiCapability({ ...h.call, entry, args, context }),
    onRejected: rejected,
  })[0]!;
  expect(z.toJSONSchema(tool.def.inputSchema).properties).not.toHaveProperty("conversation");
  const approval = mock(async () => {
    h.permissions.delete(`${PLACE_FIXTURE_PEOPLE.lea}:marta`);
    return true;
  });
  const prepared = prepareAiTools({ tools: [tool], actor: h.authority.actor }).tools[0]!;
  if (prepared.kind !== "server") throw new Error("Expected server tool");
  await expect(prepared.execute({ text: "Hi" }, { ...h.context, requestApproval: approval })).rejects.toMatchObject({
    code: "PLACE_REJECTED",
  });
  expect(approval).toHaveBeenCalledTimes(1);
  expect(rejected).toHaveBeenCalledWith("call");
  expect(h.calls).toEqual([]);
});

test.each(["access", "consent"] as const)("resume after approval rejects pending calls after %s is revoked", async (revoked) => {
  setSystemTime(new Date("2026-11-08T00:00:00Z"));
  const h = harness();
  const entry = buildAiCapabilityCatalog([h.app], "en", { ref, tools: ["note.add"] }).find(
    (entry) => entry.operation.localId === "note.add",
  )!;
  const history: { message: Message }[] = [
    { message: { role: "user", content: [{ type: "text", text: "Write at Marta" }] } },
    {
      message: {
        role: "assistant",
        stopReason: "tool_use",
        content: [
          { type: "tool_call", id: "settled", name: entry.providerName, args: { text: "Done" } },
          { type: "tool_call", id: "pending", name: entry.providerName, args: { text: "Hi" } },
        ],
      },
    },
    { message: { role: "tool_result", callId: "settled", name: entry.providerName, result: "ok" } },
  ];
  const rejected = new Set<string>();
  const resolver = createAiToolResolver({
    conversationId: "chat",
    actor: h.authority.actor,
    staticTools: [],
    store: createRunToolStore([]),
    authority: h.authority,
    listRegistry: async () => [h.app],
    listApps: async () => [
      { id: h.app.appId, name: h.app.appName, description: "", icon: h.app.appIcon, routes: [], baseUrl: "http://test.invalid" },
    ],
    place: () => resolveAiPlaceTools({ conversationId: "chat", actor: h.authority.actor, dependencies: h.place }),
    onUnavailablePlaceTools: (snapshot) => rejectUnavailablePlaceCalls(history, snapshot, rejected),
    review: (entry, args, context) => reviewAiCapability({ ...h.call, entry, args, context }),
    execute: (entry, args, context) => executeAiCapability({ ...h.call, entry, args, context }),
    onRejected: (callId) => rejected.add(callId),
  });
  expect((await resolver()).some((tool) => tool.def.name === entry.providerName)).toBe(true);
  // Review was already shown before the worker suspended for the person's answer.
  expect(await reviewAiCapability({ ...h.call, entry, args: { text: "Hi" } })).not.toBeNull();
  if (revoked === "consent") h.revokeConsent();
  else h.permissions.delete(`${PLACE_FIXTURE_PEOPLE.lea}:marta`);
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    async *stream(request) {
      expect(request.tools?.some((tool) => tool.name === entry.providerName)).toBe(false);
      yield { type: "block_start", blockId: "answer", index: 0, kind: "text" };
      yield { type: "block_end", blockId: "answer", index: 0, block: { type: "text", text: "Cannot write here now." } };
      yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
    },
  };
  const store = memoryStore();
  for (const { message } of history) await store.append(message);
  const loop = nessi({ agentId: "cloud", loopId: "resumed-turn", systemPrompt: "", store, provider, tools: resolver, maxTurns: 1 });
  // A saved approval answer is replayed on continuation, as in the Cloud executor.
  loop.push({ type: "approval_response", callId: "pending", approved: true });
  const events: OutboundEvent[] = [];
  for await (const event of loop) events.push(event);
  expect(events).toContainEqual(expect.objectContaining({ type: "turn_start", resumed: true }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", callId: "pending", isError: true }));
  expect([...rejected]).toEqual(["pending"]);
  expect(h.calls).toEqual([]);
  if (revoked === "consent") expect(h.providerCalls).toEqual(["marta", "marta"]);
  expect((await store.load()).find(({ message }) => message.role === "tool_result" && message.callId === "pending")?.message).toMatchObject(
    {
      role: "tool_result",
      callId: "pending",
      isError: true,
      reason: "unknown_tool",
    },
  );
});

test("resume rejects a historical place call when the app and its catalog are gone", () => {
  const h = harness();
  const rejected = new Set<string>();
  rejectUnavailablePlaceCalls(
    [
      {
        message: { role: "assistant", content: [{ type: "tool_call", id: "offline", name: "hashed-provider-name", args: {} }] },
        meta: {
          toolPresentations: {
            offline: {
              kind: "capability",
              appId: h.app.appId,
              appName: "Fixture",
              appIcon: "ti ti-message",
              title: "Write",
              capabilityKind: "action",
              place: ref,
            },
          },
        },
      },
    ],
    { ref, unavailable: [], available: [] },
    rejected,
  );
  expect([...rejected]).toEqual(["offline"]);
});

test("a stale general tool cannot execute an Action now reserved for places", async () => {
  const h = harness();
  const { place: _place, ...entry } = h.entry;
  await expect(executeAiCapability({ ...h.call, entry, dependencies: { getCapability: async () => h.app } })).rejects.toMatchObject({
    code: "PLACE_REJECTED",
  });
  expect(h.dispatch).not.toHaveBeenCalled();
  expect(h.calls).toEqual([]);
});

test("without consent discovery and forced execution never ask the provider", async () => {
  const h = harness();
  h.revokeConsent();
  expect(await resolveAiPlaceTools({ conversationId: "chat", actor: h.authority.actor, dependencies: h.place })).toEqual({
    ref,
    tools: [],
  });
  await expect(executeAiCapability(h.call)).rejects.toMatchObject({ code: "PLACE_REJECTED" });
  expect(h.providerCalls).toEqual([]);
  expect(h.calls).toEqual([]);
});

test("revoking consent during approval rejects the call before another provider query", async () => {
  const h = harness();
  const entry = buildAiCapabilityCatalog([h.app], "en", { ref, tools: ["note.add"] }).find(
    (entry) => entry.operation.localId === "note.add",
  )!;
  const tool = createLoadedAiCapabilityTools({
    apps: [h.app],
    catalog: [entry],
    loadedNames: [entry.name],
    actor: h.authority.actor,
    review: (entry, args, context) => reviewAiCapability({ ...h.call, entry, args, context }),
    execute: (entry, args, context) => executeAiCapability({ ...h.call, entry, args, context }),
  })[0]!;
  const prepared = prepareAiTools({ tools: [tool], actor: h.authority.actor }).tools[0]!;
  if (prepared.kind !== "server") throw new Error("Expected server tool");
  await expect(
    prepared.execute(
      { text: "Hi" },
      {
        ...h.context,
        requestApproval: async () => {
          h.revokeConsent();
          return true;
        },
      },
    ),
  ).rejects.toMatchObject({ code: "PLACE_REJECTED" });
  expect(h.providerCalls).toEqual(["marta"]);
  expect(h.calls).toEqual([]);
});

test("shared dispatcher requires the checked place binding for assistant Actions", async () => {
  const h = harness();
  const fetch = Object.assign(
    mock(async () => {
      throw new Error("Must not forward");
    }),
    { preconnect: () => {} },
  );
  for (const binding of [undefined, { ...ref, id: "jonas" }, { ...ref, type: "other.conversation" }]) {
    const response = await dispatchCapability({
      request: new Request("http://core.test/call"),
      origin: "assistant",
      kind: "actions",
      appId: h.app.appId,
      capabilityId: "reply.set",
      input: { text: "Hi" },
      target: ref,
      authority: h.authority,
      assistantPlace: binding,
      dependencies: { getCapability: async () => h.app, fetch },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "PLACE_REJECTED" });
  }
  // A matching internal binding passes this guard and reaches ordinary capability validation.
  const accepted = await dispatchCapability({
    request: new Request("http://core.test/call"),
    origin: "assistant",
    kind: "actions",
    appId: h.app.appId,
    capabilityId: "reply.set",
    input: { text: "Hi" },
    target: ref,
    authority: h.authority,
    assistantPlace: ref,
    dependencies: { getCapability: async () => h.app, fetch, getApp: async () => null },
  });
  expect(await accepted.json()).not.toMatchObject({ code: "PLACE_REJECTED" });
  expect(fetch).not.toHaveBeenCalled();
});
