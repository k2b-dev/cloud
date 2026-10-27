import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { WorkflowAiAdmissionError } from "../workflows/ai/policy";
import * as runtime from "../workflows/ai/runtime";
import * as store from "../workflows/ai/store";
import type { WorkflowAiTask } from "../workflows/ai/types";
import { type ApplicationAiTaskInput, deleteApplicationAiTasks, releaseApplicationAiTask, runApplicationAiTask } from "./application-tasks";
import * as model from "./task-model";
import type { AiResolvedModel } from "./types";

const resolved: AiResolvedModel = {
  profile: { id: "pinned", label: "Pinned", provider: "openai", model: "test", enabled: true, capabilities: [], dataBoundary: "hosted" },
  provider: {
    name: "test",
    family: "openai-compatible",
    model: "test",
    capabilities: { streaming: false, tools: false, images: false, thinking: false, usage: false },
    complete: async () => {
      throw new Error("Unused provider");
    },
    async *stream() {
      throw new Error("Unused provider");
    },
  },
};
const task: WorkflowAiTask = {
  id: "00000000-0000-4000-8000-000000000001",
  appId: "example",
  runId: null,
  stepKey: "summary",
  effectKey: "stable",
  kind: "generate_text",
  request: { kind: "generate_text", prompt: "Summarize", maxOutputChars: 100 },
  inputHash: "a".repeat(64),
  modelProfileId: "pinned",
  status: "succeeded",
  output: "Summary",
  usage: null,
  attempts: 1,
  errorCode: null,
  errorMessage: null,
  cancelRequestedAt: null,
  createdAt: "2026-10-27T09:00:00Z",
  startedAt: "2026-10-27T09:00:00Z",
  completedAt: "2026-10-27T09:00:01Z",
  updatedAt: "2026-10-27T09:00:01Z",
};
const input: ApplicationAiTaskInput = {
  appId: "example",
  scopeId: "mailbox",
  task: "summary",
  effectKey: "request-id",
  request: { kind: "generate_text", prompt: "Summarize" },
  source: {
    sourceId: "conversation",
    sourceRevision: "42",
    budget: { maxStepsPerSource: 2, tasksPerMinute: 10, burst: 20, sourcesPer24Hours: 2000, scopeConcurrent: 1, globalConcurrent: 4 },
  },
  signal: new AbortController().signal,
};
const get = spyOn(store, "getWorkflowAiTaskByEffectKey");
const create = spyOn(store, "createWorkflowAiTask");
const resolve = spyOn(model, "resolveApplicationAiTaskModel");
const submit = spyOn(runtime, "submitWorkflowAiTask");
const latest = spyOn(store, "getWorkflowAiTask");
const cancel = spyOn(store, "markWorkflowAiTaskCanceledIfRequested");
const release = spyOn(store, "releaseApplicationAiTaskByEffectKey");
afterEach(() => {
  get.mockReset();
  create.mockReset();
  resolve.mockReset();
  submit.mockReset();
  latest.mockReset();
  cancel.mockReset();
  release.mockReset();
});

test("completed replay returns durable output without resolving a changed default or charging again", async () => {
  get.mockResolvedValue(task);
  expect(await runApplicationAiTask(input)).toEqual({ output: "Summary", usage: null, input: undefined });
  expect(resolve).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

test("new application task uses shared admission/cache and pins an authorized personal model", async () => {
  get.mockResolvedValue(null);
  resolve.mockResolvedValue(resolved);
  create.mockResolvedValue({ task, created: true });
  const usageSubject = { type: "user", userId: "user-id" } as const;
  await runApplicationAiTask({ ...input, usageSubject });
  expect(resolve).toHaveBeenCalledWith(usageSubject, undefined);
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      owner: { appId: "example", scopeId: "mailbox", usageSubject },
      modelProfileId: "pinned",
      modelConfigHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      scope: input.source,
      effectKey: expect.stringMatching(/^application:/),
    }),
  );
});

test("queued recovery submits the existing task and awaits the one durable result", async () => {
  get.mockResolvedValue({ ...task, status: "queued", output: null, completedAt: null });
  submit.mockResolvedValue(undefined);
  latest.mockResolvedValue(task);
  expect(await runApplicationAiTask(input)).toEqual({ output: "Summary", usage: null, input: undefined });
  expect(submit).toHaveBeenCalledWith(task.id);
  expect(resolve).not.toHaveBeenCalled();
});

test("source/model failures stay visible and do not call the provider", async () => {
  get.mockResolvedValue({ ...task, status: "failed", errorCode: "quota_exhausted" });
  await expect(runApplicationAiTask(input)).rejects.toMatchObject({ code: "quota_exhausted" });
  expect(submit).not.toHaveBeenCalled();
});

test("scope and person namespace effect keys independently", async () => {
  get.mockResolvedValue(task);
  await runApplicationAiTask(input);
  await runApplicationAiTask({ ...input, scopeId: "other" });
  await runApplicationAiTask({ ...input, usageSubject: { type: "user", userId: "person" } });
  expect(new Set(get.mock.calls.map(([key]) => key)).size).toBe(3);
});

test("release uses the original scope/person effect identity and never runs inference", async () => {
  get.mockResolvedValue(task);
  release.mockResolvedValue(true);
  const keys = [input, { ...input, scopeId: "other" }, { ...input, usageSubject: { type: "user", userId: "person" } as const }];
  for (const key of keys) {
    await runApplicationAiTask(key);
    expect(await releaseApplicationAiTask(key)).toBe(true);
  }
  expect(release.mock.calls.map(([key]) => key.effectKey)).toEqual(get.mock.calls.map(([key]) => key));
  expect(release.mock.calls[0]?.[0]).toMatchObject({ appId: input.appId, scopeId: input.scopeId });
  expect(create).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  release.mockResolvedValue(false);
  expect(await releaseApplicationAiTask(input)).toBe(false);
});

test("owner cleanup passes literal snapshot prefixes through the public bridge without inference", async () => {
  const remove = spyOn(store, "deleteApplicationAiTasks").mockResolvedValue(3);
  const selector = { appId: input.appId, scopeId: input.scopeId, sourceIdPrefix: "conversation_%:" };
  try {
    expect(await deleteApplicationAiTasks(selector)).toBe(3);
    expect(remove).toHaveBeenCalledWith(selector);
    expect(create).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  } finally {
    remove.mockRestore();
  }
});

test("aborting one observer leaves the shared durable task available for recovery", async () => {
  const controller = new AbortController();
  get.mockResolvedValue({ ...task, status: "running", completedAt: null });
  cancel.mockResolvedValue(null);
  const running = runApplicationAiTask({ ...input, signal: controller.signal });
  queueMicrotask(() => controller.abort(new Error("Stopped")));
  await expect(running).rejects.toThrow("Stopped");
  expect(cancel).not.toHaveBeenCalled();
});

afterAll(() => {
  get.mockRestore();
  create.mockRestore();
  resolve.mockRestore();
  submit.mockRestore();
  latest.mockRestore();
  cancel.mockRestore();
  release.mockRestore();
});

test("retryable shared capacity admission waits before creating a task, without changing the policy", async () => {
  get.mockResolvedValue(null);
  resolve.mockResolvedValue(resolved);
  create.mockRejectedValueOnce(new WorkflowAiAdmissionError("WORKFLOW_AI_CAPACITY")).mockResolvedValueOnce({ task, created: true });
  expect(await runApplicationAiTask(input)).toMatchObject({ output: "Summary" });
  expect(create).toHaveBeenCalledTimes(2);
});
