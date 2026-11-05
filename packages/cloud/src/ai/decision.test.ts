import { afterEach, beforeEach, expect, expectTypeOf, spyOn, test } from "bun:test";
import type { DecisionQuestions } from "@k2b/nessi/ai";
import { type TraceContext, trace } from "../services/logging";
import { AiModelInputSchema, AiProviderSchema, aiModelSupportsSlot } from "../shared/ai-models";
import * as credentials from "./credentials";
import { AiDecisionError, createAiDecisionProvider, runAiDecision, selectAiDecisionProfile } from "./decision";
import * as calls from "./inference-calls";
import { AI_IMAGE_INPUT_MAX_BYTES, AI_TURN_ATTACHMENT_MAX_ITEMS, AI_TURN_IMAGE_MAX_TOTAL_BYTES } from "./limits";
import { aiModelAccess } from "./model-access";
import { validateAiCatalogModel } from "./model-catalog";
import { aiAssignmentFixture, aiModelFixture, aiSettingsFixture } from "./model-fixture";
import { createAiProvider } from "./provider";
import * as connection from "./provider-connections";
import { AiProviderError } from "./provider-errors";
import { observeTransport } from "./provider-transport";
import * as headers from "./request-headers";
import * as settings from "./settings";
import * as runs from "./structured-runs";

const questions = {
  urgent: { type: "noul", instructions: "Is urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { sales: "Orders", support: "Help" } },
  severity: { type: "score", instructions: "How severe?", criteria: ["Low", "High"] },
} satisfies DecisionQuestions;
const wire = {
  model: "clef",
  answers: {
    urgent: { type: "noul", noul: 0.9 },
    team: { type: "choice", choice: "support", probabilities: { sales: 0.1, support: 0.9 } },
    severity: { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
  },
  usage: { input_tokens: 23, output_tokens: 3 },
};
const profile = aiModelFixture({
  id: "clef",
  modelId: "clef",
  kind: "decision",
  provider: "openai-compatible",
  model: "cloudflare/clef",
  capabilities: [],
  contextWindow: 32768,
  pricing: { inputPerMillion: 1, outputPerMillion: 1 },
});
const state = () => aiSettingsFixture({ profiles: [profile], assignments: [aiAssignmentFixture("decision", profile.id)] });
const parent: TraceContext = { traceId: "trace", spanId: "span", traceparent: "parent" };
let restore: (() => void)[];
let requests: { path: string; body: unknown; authorization: string | null; custom: string | null }[];
let reply: (request: Request) => Response | Promise<Response>;
let server: ReturnType<typeof Bun.serve>;
let begin: ReturnType<typeof spyOn<typeof calls, "beginAiCall">>;
let finish: ReturnType<typeof spyOn<typeof calls, "finishAiCall">>;
let ledger: ReturnType<typeof spyOn<typeof runs, "safelyRecordStructuredRun">>;
let access: ReturnType<typeof spyOn<typeof aiModelAccess, "assertAllowed">>;

beforeEach(() => {
  requests = [];
  reply = () => Response.json(wire);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
        authorization: request.headers.get("authorization"),
        custom: request.headers.get("x-test"),
      });
      return reply(request);
    },
  });
  profile.baseURL = `${server.url}v1`;
  begin = spyOn(calls, "beginAiCall").mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000001",
    maxOutputTokens: profile.contextWindow,
  });
  finish = spyOn(calls, "finishAiCall").mockResolvedValue(undefined);
  ledger = spyOn(runs, "safelyRecordStructuredRun").mockResolvedValue(undefined);
  access = spyOn(aiModelAccess, "assertAllowed").mockResolvedValue(undefined);
  const span = spyOn(trace, "withSpan").mockImplementation(
    async <T>(_options: Parameters<typeof trace.withSpan>[0], run: (context: TraceContext) => T | Promise<T>) => run(parent),
  );
  const read = spyOn(settings, "readAiSettingsState").mockImplementation(async () => state());
  const key = spyOn(credentials, "getAiCredential").mockResolvedValue("fixture-key");
  const header = spyOn(headers, "getAiRequestHeaders").mockResolvedValue({ "X-Test": "fixture-header" });
  const status = spyOn(connection, "recordAiProviderStatus").mockResolvedValue(undefined);
  restore = [begin, finish, ledger, access, span, read, key, header, status].map((spy) => () => spy.mockRestore());
});
afterEach(() => {
  server.stop(true);
  for (const undo of restore.reverse()) undo();
});

test("decision catalog preserves vision, prices and model kind while excluding chat slots and providers", () => {
  const model = AiModelInputSchema.parse({
    id: "clef",
    label: "Clef",
    providerModel: "cloudflare/clef",
    kind: "decision",
    contextWindow: 32768,
    capabilities: ["vision"],
    pricing: profile.pricing,
  });
  const provider = AiProviderSchema.parse({
    id: "cortecs",
    type: "openai-compatible",
    label: "Cortecs",
    baseUrl: "https://api.cortecs.ai/v1",
    dataBoundary: "hosted",
    revision: 1,
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    updatedBy: null,
    status: "unknown",
    statusCode: null,
    statusMessage: null,
    statusCheckedAt: null,
    credentialSet: true,
    requestHeaderNames: [],
  });
  expect(() => validateAiCatalogModel(model, provider)).not.toThrow();
  expect(() => validateAiCatalogModel(model, { ...provider, dataBoundary: "restricted" })).not.toThrow();
  for (const invalid of [
    { ...model, contextWindow: null },
    { ...model, capabilities: ["tools" as const] },
    { ...model, maxOutputTokens: 5 },
  ])
    expect(() => validateAiCatalogModel(invalid, provider)).toThrow();
  expect(() => validateAiCatalogModel(model, { ...provider, type: "ollama" })).toThrow();
  expect(aiModelSupportsSlot("decision", model)).toBe(true);
  for (const slot of ["balanced", "vision", "audio", "liveAudio"] as const) expect(aiModelSupportsSlot(slot, model)).toBe(false);
  expect(aiModelSupportsSlot("decision", { kind: "chat", capabilities: ["vision"] })).toBe(false);
  expect(() => createAiProvider(profile)).toThrow("Decision models");
  expect(settings.matchesAiModelPolicy(profile, { kind: "selectable" })).toBe(false);
  expect(
    settings.matchesAiModelPolicy(
      { ...profile, capabilities: ["vision"] },
      { kind: "locked", modelId: "clef", requiredCapabilities: ["vision"] },
    ),
  ).toBe(false);
});

test("HTTP System One call returns typed answers and books one measured call and metadata run", async () => {
  const result = await runAiDecision({
    task: "mail.triage",
    state: { subject: "Please help" },
    questions,
    appId: "mail",
    attribution: { workflowRunId: "workflow" },
  });
  expectTypeOf(result.answers.team.choice).toEqualTypeOf<"sales" | "support">();
  expectTypeOf(result.answers.urgent.value).toEqualTypeOf<boolean>();
  expect(result).toMatchObject({
    model: { id: "clef" },
    usage: { input: 23, output: 3 },
    answers: {
      urgent: { value: true, probability: 0.9 },
      team: { choice: "support", confidence: 0.9 },
      severity: { level: 1, score: 0.8 },
    },
  });
  expect(result).not.toHaveProperty("raw");
  expect(requests).toEqual([
    {
      path: "/v1/systemone",
      body: { model: "cloudflare/clef", state: { subject: "Please help" }, questions },
      authorization: "Bearer fixture-key",
      custom: "fixture-header",
    },
  ]);
  expect(begin.mock.calls[0]?.[1]).toMatchObject({
    kind: "background",
    task: "mail.triage",
    appId: "mail",
    workflowRunId: "workflow",
    modelRef: { id: "clef" },
  });
  expect(begin.mock.calls[0]?.[4]).toBe(32768);
  expect(finish).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001", result.usage, "ok", expect.anything());
  expect(ledger).toHaveBeenCalledWith(expect.objectContaining({ mode: "decision", status: "ok", usage: result.usage, attempts: 1 }));
  expect(JSON.stringify(ledger.mock.calls)).not.toContain("Please help");
});

test("default and explicit model selection enforce boundaries and never fall back to chat", () => {
  expect(selectAiDecisionProfile(state()).id).toBe("clef");
  expect(() => selectAiDecisionProfile(aiSettingsFixture())).toThrow(AiDecisionError);
  expect(() => selectAiDecisionProfile({ ...state(), enabled: false })).toThrow(AiDecisionError);
  for (const changed of [
    { ...profile, enabled: false },
    { ...profile, kind: "chat" as const },
    { ...profile, contextWindow: undefined },
  ])
    expect(() => selectAiDecisionProfile({ ...state(), profiles: [changed] })).toThrow(AiDecisionError);
  const restricted = { ...state(), profiles: [{ ...profile, dataBoundary: "restricted" as const }] };
  expect(() => selectAiDecisionProfile(restricted)).toThrow(AiDecisionError);
  expect(selectAiDecisionProfile(restricted, { model: { id: "clef" } }).id).toBe("clef");
  expect(() => selectAiDecisionProfile(restricted, { model: { id: "clef" }, usageSubject: { type: "user", userId: "user" } })).toThrow(
    AiDecisionError,
  );
  expect(() => selectAiDecisionProfile(state(), { allowedDataBoundaries: ["hosted"] })).toThrow(AiDecisionError);
  expect(() => selectAiDecisionProfile(state(), { model: { id: "missing" } })).toThrow(AiDecisionError);
});

test("person-facing decisions enforce grants and charge that subject, with no dispatch on denial", async () => {
  const subject = { type: "user", userId: "person" } as const;
  await runAiDecision({ task: "mail.triage", state: "Test", questions, usageSubject: subject });
  expect(access).toHaveBeenCalledWith("clef", subject);
  expect(begin.mock.calls[0]?.[1]).toMatchObject({ kind: "chat", subject });
  access.mockRejectedValue(Object.assign(new Error("Access denied"), { aiError: { code: "model_policy_mismatch" } }));
  await expect(runAiDecision({ task: "mail.triage", state: "Test", questions, usageSubject: subject })).rejects.toThrow("Access denied");
  expect(requests).toHaveLength(1);
  expect(begin).toHaveBeenCalledTimes(1);
  expect(ledger.mock.calls.at(-1)?.[0].errorCode).toBe("model_policy_mismatch");
});

test("invalid questions, unserializable state and context overflow fail before accounting or HTTP", async () => {
  for (const questions of [
    {},
    Object.fromEntries(Array.from({ length: 129 }, (_, index) => [String(index), { type: "noul", instructions: "?" }])),
    { one: { type: "score", instructions: "?", criteria: ["one"] } },
    JSON.parse('{"__proto__":{"type":"noul","instructions":"?"}}'),
  ]) {
    await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "decision_input_invalid" });
  }
  for (const task of ["", " ", `${" ".repeat(120)}a`])
    await expect(runAiDecision({ task, state: "test", questions })).rejects.toMatchObject({ code: "decision_input_invalid" });
  for (const state of [
    undefined,
    1n,
    (() => {
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      return cyclic;
    })(),
  ])
    await expect(runAiDecision({ task: "test", state, questions })).rejects.toMatchObject({ code: "decision_input_invalid" });
  await expect(runAiDecision({ task: "test", state: "x".repeat(profile.contextWindow! * 4), questions })).rejects.toMatchObject({
    code: "decision_input_too_large",
  });
  expect(begin).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});

test("128 questions are accepted and images require vision and respect shared count, per-image and total limits", async () => {
  const many = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "?" }]));
  reply = () =>
    Response.json({ answers: Object.fromEntries(Object.keys(many).map((id) => [id, { type: "noul", noul: 0.5 }])), usage: wire.usage });
  expect(Object.keys((await runAiDecision({ task: "test", state: "test", questions: many })).answers)).toHaveLength(128);
  reply = () => Response.json(wire);
  const image = { data: "aGVsbG8=", mediaType: "image/png" };
  await expect(runAiDecision({ task: "test", state: "test", questions, images: [image] })).rejects.toMatchObject({
    code: "decision_images_not_supported",
  });
  const resolveModel = async () => {
    const vision = { ...profile, capabilities: ["vision" as const] };
    return { profile: vision, provider: createAiDecisionProvider(vision) };
  };
  await runAiDecision({ task: "test", state: "test", questions, images: [image], resolveModel });
  expect(requests.at(-1)?.body).toMatchObject({ images: ["data:image/png;base64,aGVsbG8="] });
  const oversized = { ...image, data: Buffer.alloc(AI_IMAGE_INPUT_MAX_BYTES + 1).toString("base64") };
  for (const images of [
    [{ ...image, mediaType: "application/pdf" }],
    [{ ...image, data: "data:image/png;base64,aGVsbG8=" }],
    Array(AI_TURN_ATTACHMENT_MAX_ITEMS + 1).fill(image),
  ])
    await expect(runAiDecision({ task: "test", state: "test", questions, images, resolveModel })).rejects.toMatchObject({
      code: "decision_input_invalid",
    });
  await expect(runAiDecision({ task: "test", state: "test", questions, images: [oversized], resolveModel })).rejects.toMatchObject({
    code: "decision_input_too_large",
  });
  const full = { ...image, data: Buffer.alloc(AI_IMAGE_INPUT_MAX_BYTES).toString("base64") };
  await expect(
    runAiDecision({
      task: "test",
      state: "test",
      questions,
      images: Array(AI_TURN_IMAGE_MAX_TOTAL_BYTES / AI_IMAGE_INPUT_MAX_BYTES + 1).fill(full),
      resolveModel,
    }),
  ).rejects.toMatchObject({ code: "decision_input_too_large" });
});

for (const status of [401, 429, 500, 502, 503, 504, 529])
  test(`HTTP ${status} is sanitized and accounting distinguishes refused and possibly processed calls`, async () => {
    reply = () => Response.json({ error: { message: "PRIVATE SOURCE AND KEY" } }, { status });
    await expect(runAiDecision({ task: "test", state: "PRIVATE SOURCE", questions })).rejects.toBeInstanceOf(AiProviderError);
    expect(finish.mock.calls[0]?.[1]).toMatchObject(
      status < 500 || status === 503 || status === 529 ? { input: 0, output: 0 } : { estimated: true },
    );
    expect(connection.recordAiProviderStatus).toHaveBeenCalledWith(
      profile.providerId,
      expect.objectContaining({ status: status === 401 ? "key_rejected" : "error", httpStatus: status }),
    );
    expect(JSON.stringify([finish.mock.calls, ledger.mock.calls])).not.toContain("PRIVATE SOURCE");
    expect(requests).toHaveLength(1);
  });

test("decision transport forwards one report through nested observers without changing global fetch", async () => {
  const originalFetch = globalThis.fetch;
  const now = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  restore.push(() => now.mockRestore());
  const reports: unknown[] = [];
  const provider = createAiDecisionProvider(profile);
  await provider.decide(
    observeTransport({ state: "test", questions, onTransport: (report) => reports.push(report) }, (report) => reports.push(report)),
  );
  expect(reports).toEqual(
    Array(2).fill({ startedAt: 1_800_000_000_000, headersAt: 1_800_000_000_000, firstByteAt: 1_800_000_000_000, status: 200 }),
  );
  await runAiDecision({ task: "test", state: "test", questions });
  expect(finish.mock.calls[0]?.[3]).toMatchObject({ requestStartedAt: 1_800_000_000_000, headersMs: 0, firstByteMs: 0 });
  expect(globalThis.fetch).toBe(originalFetch);
});

test("a refused connection is sanitized, marks the provider unreachable and books zero usage", async () => {
  server.stop(true);
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "provider_error" });
  expect(finish.mock.calls[0]?.[1]).toEqual({ input: 0, output: 0, total: 0 });
  expect(connection.recordAiProviderStatus).toHaveBeenCalledWith(profile.providerId, expect.objectContaining({ status: "unreachable" }));
  expect(requests).toHaveLength(0);
});

test("a connection reset can follow delivery and keeps an estimated charge", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
    Object.assign(new TypeError("PRIVATE CONNECTION DETAILS"), { code: "ECONNRESET" }),
  );
  restore.push(() => fetch.mockRestore());
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "provider_error" });
  expect(finish.mock.calls[0]?.[1]).toMatchObject({ estimated: true });
  expect(connection.recordAiProviderStatus).toHaveBeenCalledWith(profile.providerId, expect.objectContaining({ status: "unreachable" }));
  expect(JSON.stringify([finish.mock.calls, ledger.mock.calls])).not.toContain("PRIVATE CONNECTION DETAILS");
});

test("decision answer decoding preserves fallback probabilities and rejects incompatible answers", async () => {
  reply = () =>
    Response.json({ ...wire, answers: { ...wire.answers, severity: { type: "score", probabilities: { "0": 0.2, "1": 0.8 } } } });
  expect((await runAiDecision({ task: "test", state: "test", questions })).answers.severity).toMatchObject({
    score: 0.8,
    level: 1,
    confidence: 0.8,
  });
  for (const answer of [
    { ...wire.answers, urgent: { type: "noul", noul: 2 } },
    { ...wire.answers, team: { type: "choice", choice: "missing" } },
    { ...wire.answers, severity: { type: "score", score: 2 } },
  ]) {
    reply = () => Response.json({ ...wire, answers: answer });
    await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "provider_error" });
    expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({ estimated: true });
  }
});

test("missing usage is estimated, malformed answers fail visibly, and admission is never retried", async () => {
  reply = () => Response.json({ ...wire, usage: undefined });
  expect((await runAiDecision({ task: "test", state: "test", questions })).usage).toMatchObject({ estimated: true, output: 0 });
  reply = () => Response.json({ answers: {} });
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "provider_error" });
  expect(ledger.mock.calls.at(-1)?.[0]).toMatchObject({ status: "failed", errorCode: "provider_error" });
  begin.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000001", maxOutputTokens: 1 });
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({
    code: "ai_background_budget_insufficient",
  });
  expect(finish.mock.calls.at(-1)?.[1]).toMatchObject({ input: 0, output: 0 });
  expect(requests).toHaveLength(2);
  begin.mockRejectedValue(new calls.AiBackgroundAdmissionError(true));
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "ai_background_budget_reserved" });
  expect(begin).toHaveBeenCalledTimes(4);
});

test("cancellation before dispatch makes no call, and cancellation in flight settles accounting", async () => {
  await expect(runAiDecision({ task: "test", state: "test", questions, signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: "provider_aborted",
  });
  expect(begin).not.toHaveBeenCalled();
  const controller = new AbortController();
  reply = () => {
    controller.abort();
    return Response.json(wire);
  };
  await expect(runAiDecision({ task: "test", state: "test", questions, signal: controller.signal })).rejects.toMatchObject({
    code: "provider_aborted",
  });
  expect(finish.mock.calls[0]?.[2]).toBe("aborted");
  expect(finish.mock.calls[0]?.[3]).toMatchObject({ cancelled: true });
  expect(connection.recordAiProviderStatus).not.toHaveBeenCalled();
});

test("the internal deadline is a provider failure, not caller cancellation", async () => {
  const deadline = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  restore.push(() => timeout.mockRestore());
  reply = () => {
    deadline.abort(new DOMException("Deadline expired", "TimeoutError"));
    return Response.json(wire);
  };
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "provider_error" });
  expect(finish.mock.calls[0]?.[2]).toBe("failed");
  expect(finish.mock.calls[0]?.[3]).toMatchObject({ cancelled: false });
  expect(connection.recordAiProviderStatus).toHaveBeenCalledWith(profile.providerId, {
    status: "unreachable",
    message: "The provider timed out.",
  });
  expect(ledger.mock.calls[0]?.[0]).toMatchObject({ errorCode: "provider_error", status: "failed" });
});

test("the run ledger preserves the background cost safety stop", async () => {
  begin.mockRejectedValue(new calls.AiBackgroundCostError());
  await expect(runAiDecision({ task: "test", state: "test", questions })).rejects.toMatchObject({ code: "ai_background_cost_stop" });
  expect(ledger.mock.calls[0]?.[0].errorCode).toBe("ai_background_cost_stop");
  expect(requests).toHaveLength(0);
});
