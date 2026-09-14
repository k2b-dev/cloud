import { describe, expect, it } from "bun:test";
import type { Message } from "@k2b/nessi";
import type { z } from "zod";
import {
  type AiChatEnrichment,
  buildEnrichmentTranscript,
  enrichDirtyAiConversations,
  shouldApplyEnrichedDescription,
  shouldApplyEnrichedTitle,
} from "./enrich";
import type { RunAiStructuredInput, RunAiStructuredResult } from "./structured";
import type { AiEnrichmentCandidate, AiResolvedModel, AiStoredMessage } from "./types";

const conversation = (overrides: Partial<AiEnrichmentCandidate> = {}): AiEnrichmentCandidate => ({
  id: "00000000-0000-0000-0000-00000000c001",
  shortId: "cNv234",
  title: "New chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  doneAt: null, archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: null,
  createdAt: "2026-07-09T10:00:00.000Z",
  updatedAt: "2026-07-09T10:05:00.000Z",
  // Exact Postgres timestamp — deliberately more precise than updatedAt.
  dirtyAsOf: "2026-07-09 10:05:00.000123+00",
  enrichFailCount: 0,
  ...overrides,
});

const stored = (seq: number, message: Message): AiStoredMessage => ({
  id: `message-${seq}`,
  shortId: `mSg23${seq + 1}`,
  conversationId: "00000000-0000-0000-0000-00000000c001",
  seq,
  kind: "message",
  message,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopId: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-07-09T10:00:00.000Z",
});

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistantMessage = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

const enrichment = (overrides: Partial<AiChatEnrichment> = {}): AiChatEnrichment => ({
  summary: "A chat about testing.",
  keywords: ["testing"],
  title: "",
  topicChanged: false,
  ...overrides,
});

const fakeResolvedModel = { profile: { id: "test-model" } } as unknown as AiResolvedModel;

const fakeStructured =
  (result: AiChatEnrichment, calls: RunAiStructuredInput<z.ZodType>[] = []) =>
  async <TOutput extends z.ZodType>(input: RunAiStructuredInput<TOutput>): Promise<RunAiStructuredResult<TOutput>> => {
    calls.push(input as RunAiStructuredInput<z.ZodType>);
    return {
      output: result as z.infer<TOutput>,
      modelProfileId: "test-model",
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    };
  };

describe("buildEnrichmentTranscript", () => {
  it("keeps user and assistant text in order and skips tool results", () => {
    const transcript = buildEnrichmentTranscript([
      stored(1, userMessage("How do I write tests?")),
      stored(2, assistantMessage("Use bun test.")),
      stored(3, { role: "tool_result", callId: "c1", result: "noise" } as Message),
    ]);
    expect(transcript).toBe("user: How do I write tests?\nassistant: Use bun test.");
  });

  it("caps at maxChars keeping the newest messages", () => {
    const transcript = buildEnrichmentTranscript(
      [stored(1, userMessage("old ".repeat(50))), stored(2, userMessage("newest question"))],
      40,
    );
    expect(transcript).toContain("newest question");
    expect(transcript.length).toBeLessThanOrEqual(60);
  });
});

describe("shouldApplyEnrichedTitle", () => {
  it("never overrides a user-chosen title", () => {
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "user" }), enrichment({ title: "Better", topicChanged: true }))).toBe(
      false,
    );
  });

  it("replaces default titles whenever a suggestion exists", () => {
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "default" }), enrichment({ title: "Better" }))).toBe(true);
  });

  it("replaces auto titles only when the topic changed", () => {
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "auto" }), enrichment({ title: "Better" }))).toBe(false);
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "auto" }), enrichment({ title: "Better", topicChanged: true }))).toBe(true);
  });

  it("does nothing without a suggestion", () => {
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "default" }), enrichment({ title: "" }))).toBe(false);
  });

  it("treats literal null/none strings and the unchanged title as no suggestion", () => {
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "default" }), enrichment({ title: "null" }))).toBe(false);
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "default" }), enrichment({ title: " None " }))).toBe(false);
    expect(shouldApplyEnrichedTitle(conversation({ titleSource: "default", title: "Same" }), enrichment({ title: "Same" }))).toBe(false);
  });
});

describe("shouldApplyEnrichedDescription", () => {
  it("refreshes default and auto descriptions but never user-authored ones", () => {
    expect(shouldApplyEnrichedDescription(conversation({ descriptionSource: "default" }))).toBe(true);
    expect(shouldApplyEnrichedDescription(conversation({ descriptionSource: "auto" }))).toBe(true);
    expect(shouldApplyEnrichedDescription(conversation({ descriptionSource: "user" }))).toBe(false);
  });
});

describe("enrichDirtyAiConversations", () => {
  const makeStore = (candidates: AiEnrichmentCandidate[], messages: AiStoredMessage[]) => {
    const applied: Parameters<typeof import("./store")["aiConversations"]["applyEnrichment"]>[0][] = [];
    const failed: string[] = [];
    const recorded: Parameters<typeof import("./store")["aiConversations"]["recordEnrichmentRun"]>[0][] = [];
    return {
      applied,
      failed,
      recorded,
      store: {
        listEnrichmentCandidates: async () => candidates,
        listMessages: async () => messages,
        applyEnrichment: async (input: (typeof applied)[number]) => {
          applied.push(input);
        },
        markEnrichmentFailed: async (input: { conversationId: string }) => {
          failed.push(input.conversationId);
        },
        recordEnrichmentRun: async (input: (typeof recorded)[number]) => {
          recorded.push(input);
        },
      },
    };
  };

  it("applies summary, keywords, and enriched_at from scan time", async () => {
    const target = conversation();
    const { store, applied, recorded } = makeStore([target], [stored(1, userMessage("Explain GQL joins"))]);
    const calls: RunAiStructuredInput<z.ZodType>[] = [];

    const summary = await enrichDirtyAiConversations({
      deps: {
        store,
        structured: fakeStructured(enrichment({ summary: "GQL join discussion.", keywords: ["GQL ", "Joins"], title: "GQL joins" }), calls),
        resolveModel: async () => fakeResolvedModel,
      },
    });

    expect(summary).toEqual({ scanned: 1, enriched: 1, titlesUpdated: 1, skipped: 0, failed: 0 });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      conversationId: target.id,
      description: "GQL join discussion.",
      keywords: ["gql", "joins"],
      title: "GQL joins",
      dirtyAsOf: target.dirtyAsOf,
    });
    expect(calls[0]?.task).toBe("chat-enrich");
    expect(calls[0]?.input).toContain("Explain GQL joins");
    expect(recorded[0]).toMatchObject({ status: "ok", trigger: "scheduled", titleUpdated: true, keywordsCount: 2 });
  });

  it("keeps a failing conversation dirty and continues with the rest", async () => {
    const first = conversation({ id: "00000000-0000-0000-0000-00000000c001" });
    const second = conversation({ id: "00000000-0000-0000-0000-00000000c002", titleSource: "user" });
    const { store, applied } = makeStore([first, second], [stored(1, userMessage("hello"))]);

    let call = 0;
    const summary = await enrichDirtyAiConversations({
      deps: {
        store,
        structured: async <TOutput extends z.ZodType>(input: RunAiStructuredInput<TOutput>) => {
          call += 1;
          if (call === 1) throw new Error("provider down");
          return fakeStructured(enrichment())(input);
        },
        resolveModel: async () => fakeResolvedModel,
      },
    });

    expect(summary).toEqual({ scanned: 2, enriched: 1, titlesUpdated: 0, skipped: 0, failed: 1 });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.conversationId).toBe(second.id);
    expect(applied[0]?.title).toBeUndefined();
  });

  it("marks failing conversations for backoff", async () => {
    const target = conversation();
    const { store, failed, recorded } = makeStore([target], [stored(1, userMessage("hello"))]);

    await enrichDirtyAiConversations({
      deps: {
        store,
        structured: async <TOutput extends z.ZodType>(_input: RunAiStructuredInput<TOutput>): Promise<RunAiStructuredResult<TOutput>> => {
          throw new Error("provider down");
        },
        resolveModel: async () => fakeResolvedModel,
      },
    });

    expect(failed).toEqual([target.id]);
    expect(recorded[0]).toMatchObject({ status: "failed", trigger: "scheduled", error: "provider down" });
  });

  it("uses the manual trigger and forces the given conversation", async () => {
    const target = conversation({ enrichFailCount: 3 });
    const { store, recorded, applied } = makeStore([target], [stored(1, userMessage("hello"))]);

    const summary = await enrichDirtyAiConversations({
      conversationId: target.id,
      deps: { store, structured: fakeStructured(enrichment()), resolveModel: async () => fakeResolvedModel },
    });

    expect(summary.enriched).toBe(1);
    expect(applied).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ status: "ok", trigger: "manual" });
  });

  it("marks transcript-less conversations clean without an LLM call", async () => {
    const target = conversation();
    const { store, applied } = makeStore([target], [stored(1, { role: "tool_result", callId: "c1", result: "only tools" } as Message)]);
    const calls: RunAiStructuredInput<z.ZodType>[] = [];

    const summary = await enrichDirtyAiConversations({
      deps: { store, structured: fakeStructured(enrichment(), calls), resolveModel: async () => fakeResolvedModel },
    });

    expect(summary).toEqual({ scanned: 1, enriched: 0, titlesUpdated: 0, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(0);
    expect(applied[0]).toMatchObject({ keywords: [], dirtyAsOf: target.dirtyAsOf });
    expect(applied[0]?.description).toBeUndefined();
  });

  it("is a quiet no-op when no background model resolves (AI disabled)", async () => {
    const { store } = makeStore([conversation()], []);
    const summary = await enrichDirtyAiConversations({
      deps: {
        store,
        structured: fakeStructured(enrichment()),
        resolveModel: async () => {
          throw new Error("AI is disabled.");
        },
      },
    });
    expect(summary).toEqual({ scanned: 0, enriched: 0, titlesUpdated: 0, skipped: 0, failed: 0 });
  });
});
