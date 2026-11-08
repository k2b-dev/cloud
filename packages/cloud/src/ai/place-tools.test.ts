import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { Message, ToolContext } from "@k2b/nessi";
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
import type { dispatchCapability } from "../api/capabilities";
import { capabilityCallFromTool, capabilityToolInputSchema } from "../capabilities/calls";
import * as executions from "../capabilities/executions";
import type { RequestAuthority } from "../server";
import * as categories from "../services/account-category-policy";
import { buildAiCapabilityCatalog, createAiToolResolver, createLoadedAiCapabilityTools, createRunToolStore } from "./capabilities";
import { executeAiCapability, reviewAiCapability } from "./capability-execution";
import { rejectUnavailablePlaceCalls, resolveAiPlaceTools } from "./place-tools";
import { prepareAiTools } from "./tools";
import type { AiConversation } from "./types";

useUnitClients();
afterEach(() => mock.restore());
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
  const place = {
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

test("resume removes revoked tools and rejects only unresolved historical calls", async () => {
  const h = harness();
  const missing = mock((names: readonly string[]) => names);
  const store = createRunToolStore([]);
  const resolver = createAiToolResolver({
    conversationId: "chat",
    actor: h.authority.actor,
    staticTools: [],
    store,
    authority: h.authority,
    listRegistry: async () => [h.app],
    listApps: async () => [
      { id: h.app.appId, name: h.app.appName, description: "", icon: h.app.appIcon, routes: [], baseUrl: "http://test.invalid" },
    ],
    place: () => resolveAiPlaceTools({ conversationId: "chat", actor: h.authority.actor, dependencies: h.place }),
    onUnavailablePlaceTools: missing,
    execute: async () => ({}),
  });
  expect((await resolver()).some((x) => x.def.name === h.entry.providerName)).toBe(true);
  h.permissions.delete(`${PLACE_FIXTURE_PEOPLE.lea}:marta`);
  expect((await resolver()).some((x) => x.def.name === h.entry.providerName)).toBe(false);
  const messages: { message: Message }[] = [
    {
      message: {
        role: "assistant",
        content: [
          { type: "tool_call", id: "settled", name: h.entry.providerName, args: {} },
          { type: "tool_call", id: "pending", name: h.entry.providerName, args: {} },
        ],
      },
    },
    { message: { role: "tool_result", callId: "settled", name: h.entry.providerName, result: "ok" } },
  ];
  const rejected = new Set<string>();
  rejectUnavailablePlaceCalls(messages, missing.mock.calls.at(-1)![0], rejected);
  expect([...rejected]).toEqual(["pending"]);
});
