import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Provider } from "@k2b/nessi";
import type { AccessSubject } from "../server";
import { __aiExecutorTest, AiTurnExecutor } from "./executor";
import { aiModelAccess } from "./model-access";
import { aiModelFixture, aiSettingsFixture } from "./model-fixture";
import { userResourceContext } from "./projects.test-fixture";
import { aiConversations } from "./store";
import type { AiTurnFailureInfo } from "./turn-failure";
import type { AiChatTurnRunConfig, AiCompactionTurnRunConfig, AiConversation, AiTurnClaim } from "./types";

// Fictional people and IDs; no real data.
const ownerId = "00000000-0000-4000-8000-000000000001";
const owner = userResourceContext({ type: "user", userId: ownerId });
const serviceAccount: AccessSubject = { type: "service_account", serviceAccountId: "00000000-0000-4000-8000-000000000002" };
const deniedText = "You do not have permission to use this model. Choose another model.";
const denied = () =>
  Object.assign(new Error(deniedText), {
    aiError: { code: "model_policy_mismatch" as const, message: "denied" },
  });

const at = "2026-11-20T00:00:00.000Z";
const chat: AiConversation = {
  id: "chat",
  shortId: "Chat01",
  title: "Stock",
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: ownerId,
  allowedTools: null,
  createdAt: at,
  updatedAt: at,
};

let access: ReturnType<typeof spyOn<typeof aiModelAccess, "assertAllowed">>;
let conversation: ReturnType<typeof spyOn<typeof aiConversations, "getConversation">>;
beforeEach(() => {
  access = spyOn(aiModelAccess, "assertAllowed").mockRejectedValue(denied());
  conversation = spyOn(aiConversations, "getConversation").mockResolvedValue(chat);
});
afterEach(() => {
  access.mockRestore();
  conversation.mockRestore();
});

const harness = () => {
  let providerCalls = 0;
  let admissions = 0;
  const finalized: { status: string; failure: AiTurnFailureInfo | null }[] = [];
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "chat",
    contextWindow: 8_000,
    capabilities: { streaming: true, tools: false, images: false, thinking: false, usage: true },
    stream: () => {
      providerCalls++;
      throw new Error("The model must not be called");
    },
  };
  const profile = aiModelFixture({ id: "restricted", modelId: "restricted" });
  const executor = new AiTurnExecutor({
    leaseOwner: "worker",
    heartbeatMs: 1000,
    enqueueContinuation: async () => {},
    // Admission is the next step after the model check; stopping here keeps the test free of later effects.
    beforeChatTurn: async () => {
      admissions++;
      throw new Error("Stopped after admission");
    },
    validateTurn: async () => ({
      settings: aiSettingsFixture({ profiles: [profile] }),
      resolved: { model: { id: profile.id }, profile, provider },
    }),
  });
  executor["finalize"] = async (_conversation, _turn, _pipeline, status, failure) => {
    finalized.push({ status, failure });
    return "completed";
  };
  const pipeline = new __aiExecutorTest.StreamPipeline({
    conversationId: "chat",
    turnId: "turn",
    attempt: 1,
    startSeq: 0,
    leaseOwner: "worker",
    seedBlocks: [],
    allowRememberedApprovals: false,
  });
  pipeline.flush = async () => {};
  const claim = (runConfig: AiTurnClaim["runConfig"], attempt = 1): AiTurnClaim => ({
    turn: {
      id: "turn",
      shortId: "Turn01",
      conversationId: "chat",
      status: "running",
      attempt,
      modelId: profile.id,
      createdAt: at,
      completedAt: null,
      error: null,
    },
    runConfig,
    liveSeq: 0,
    liveBlocks: [],
  });
  return { executor, pipeline, claim, finalized, counts: () => ({ providerCalls, admissions }) };
};

const send = { id: "00000000-0000-4000-8000-000000000003", accountId: ownerId, keyHash: "key", requestHash: "request" };
const base = { kind: "chat" as const, input: "Please continue.", toolSource: { kind: "none" as const }, actor: owner.actor };
type StartPath = { config: AiChatTurnRunConfig; attempt?: number; resumed?: boolean; subject: AccessSubject };
const person: AccessSubject = { type: "user", userId: ownerId };
const paths: Record<string, StartPath> = {
  "a person in a signed-in session": { config: { ...base, assistantChat: true, signedInSession: true }, subject: person },
  "ai.chat.send from Code": {
    config: {
      ...base,
      assistantChat: true,
      send,
      writerOrigin: { kind: "automation", id: "Code01", resource: { type: "core.code", id: "Code01" } },
      turnTrigger: { kind: "automation", id: "Code01" },
      codeOrigin: { codeId: "Code01", title: "Stock check", runId: "Run001", requestId: "Req001", label: "Stock check" },
    },
    subject: person,
  },
  "ai.chat.send from another chat": {
    config: {
      ...base,
      assistantChat: true,
      send,
      writerOrigin: { kind: "chat", id: "Chat02", turnId: "Turn02" },
      turnTrigger: { kind: "chat", id: "Chat02" },
    },
    subject: person,
  },
  "the automation queue": {
    config: {
      ...base,
      assistantChat: true,
      send,
      writerOrigin: { kind: "automation", id: "Code01" },
      turnTrigger: { kind: "automation", id: "Code01" },
    },
    subject: person,
  },
  "a retried attempt": { config: { ...base, assistantChat: true }, attempt: 2, subject: person },
  "a resumed turn": { config: { ...base, assistantChat: true }, attempt: 2, resumed: true, subject: person },
  "cld with an API key": { config: { ...base, assistantChat: true, sourceRestricted: true }, subject: person },
  "a service account": {
    config: { ...base, assistantChat: true, actor: undefined, accessSubject: serviceAccount },
    subject: serviceAccount,
  },
  "a schedule": {
    config: {
      ...base,
      assistantChat: true,
      send,
      wakeup: {
        id: "00000000-0000-4000-8000-000000000004",
        scheduledAt: "2026-11-20T06:00:00.000Z",
        firedAt: "2026-11-20T06:00:01.000Z",
        snoozes: 0,
      },
      writerOrigin: { kind: "wakeup", id: "00000000-0000-4000-8000-000000000004", scheduledAt: "2026-11-20T06:00:00.000Z" },
      turnTrigger: { kind: "wakeup", id: "00000000-0000-4000-8000-000000000004" },
    },
    subject: person,
  },
  "a stored turn without the Assistant marker": {
    config: { ...base, writerOrigin: { kind: "chat", id: "Chat02", turnId: "Turn02" }, turnTrigger: { kind: "chat", id: "Chat02" } },
    subject: person,
  },
};

test.each(Object.keys(paths))("a turn starts only with a model the person may use (%s)", async (name) => {
  const path = paths[name]!;
  const { executor, pipeline, claim, finalized, counts } = harness();
  await executor["runChat"](
    "chat",
    "turn",
    claim(path.config, path.attempt),
    path.config,
    pipeline,
    new AbortController().signal,
    path.resumed ?? false,
  );
  expect(access).toHaveBeenCalledWith("restricted", path.subject);
  expect(finalized).toEqual([
    { status: "failed", failure: expect.objectContaining({ error: { code: "not_allowed" }, detail: deniedText }) },
  ]);
  expect(counts()).toEqual({ providerCalls: 0, admissions: 0 });
});

test("a turn without an access subject never starts", async () => {
  const config: AiChatTurnRunConfig = { ...base, actor: undefined };
  const { executor, pipeline, claim, finalized, counts } = harness();
  await executor["runChat"]("chat", "turn", claim(config), config, pipeline, new AbortController().signal);
  expect(access).toHaveBeenCalledWith("restricted", null);
  expect(finalized.map(({ status }) => status)).toEqual(["failed"]);
  expect(counts().providerCalls).toBe(0);
});

test("a compaction runs only with a model the person may use", async () => {
  const config: AiCompactionTurnRunConfig = { kind: "compact", actor: owner.actor, model: { id: "restricted" } };
  const { executor, pipeline, finalized, counts } = harness();
  await executor["runCompaction"]("chat", "turn", pipeline, config, new AbortController().signal);
  expect(access).toHaveBeenCalledWith("restricted", person);
  expect(finalized).toEqual([
    { status: "failed", failure: expect.objectContaining({ error: { code: "not_allowed" }, detail: deniedText }) },
  ]);
  expect(counts().providerCalls).toBe(0);
});

test("a permitted model passes the same check and reaches admission", async () => {
  access.mockResolvedValue(undefined);
  const config: AiChatTurnRunConfig = { ...paths["ai.chat.send from Code"]!.config };
  const { executor, pipeline, claim, finalized, counts } = harness();
  await executor["runChat"]("chat", "turn", claim(config), config, pipeline, new AbortController().signal);
  expect(access).toHaveBeenCalledWith("restricted", person);
  expect(counts()).toEqual({ providerCalls: 0, admissions: 1 });
  expect(finalized).toEqual([{ status: "failed", failure: expect.objectContaining({ detail: "Stopped after admission" }) }]);
});
