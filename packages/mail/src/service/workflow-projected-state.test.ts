import { describe, expect, mock, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowJsonValue, WorkflowStepOutcome } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import type { FrozenMailWorkflowSource } from "./workflow-data";
import {
  applyMailConversationTransition,
  applyMailMessageTransition,
  createMailWorkflowProjectedState,
  rebindMailWorkflowRestoredOutput,
  restoreMailWorkflowProjectedState,
} from "./workflow-projected-state";
import { projectMailWorkflowFrozenMessage } from "./workflow-runtime-values";

const plan = {
  inputs: [
    { name: "message", type: "mailMessage", config: {} },
    { name: "conversation", type: "mailConversation", config: {} },
  ],
} as WorkflowBoundPlan;

const source = {
  message: { id: "message", folderId: "inbox", keywords: ["finance"] },
  conversation: { id: "conversation", workStatus: "needs_action", summary: null, summaryRevision: 1, revision: 2 },
} as unknown as FrozenMailWorkflowSource;

describe("Mail workflow projected state", () => {
  test("shares projected objects between context and declared inputs without mutating the snapshot", () => {
    const projected = createMailWorkflowProjectedState(plan, source, { caller: "kept" });

    expect(projected.inputs.message).toBe(projected.source.message);
    expect(projected.inputs.conversation).toBe(projected.source.conversation);
    expect(projected.inputs.caller).toBe("kept");

    applyMailMessageTransition(projected.source.message, "moveMessage", "archive");
    expect((projected.inputs.message as Record<string, unknown>).folderId).toBe("archive");
    expect(source.message.folderId).toBe("inbox");
  });

  test.each([false, true])("rebinds nested restored aliases after body hydration: %s", async (hydrated) => {
    const message: Record<string, WorkflowJsonValue> = {
      id: "message",
      flags: [],
      body: "",
      bodyText: "",
      bodyHtml: "",
      bodyAvailable: false,
      textLength: null,
    };
    const conversation = { id: "conversation", workStatus: "done" };
    const output = {
      nested: [{ message: structuredClone(message), conversation: structuredClone(conversation) }],
      other: { id: "other" },
      // Built from the message id only: a separate value in the live run, so it stays one.
      built: { id: "message", note: "kept" },
      scalar: null,
    };
    if (hydrated) projectMailWorkflowFrozenMessage("message", message, { "inputs.message.bodyText": "Reply" });
    const ctx = { invocation: { context: { source: { message, conversation } } } } as unknown as WorkflowExecuteActionContext;
    const handler = rebindMailWorkflowRestoredOutput({
      execute: async () => ({ state: "completed" }),
      restoreCompleted: (_ctx, _step, restored) => {
        const value = restored.output;
        if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.nested))
          throw new Error("Expected nested output");
        const nested = value.nested[0];
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) throw new Error("Expected nested aliases");
        expect(nested.message).toBe(message);
        expect(message.textLength).toBe(hydrated ? 5 : null);
        applyMailMessageTransition(message, "addFlag", "seen");
        expect(nested.message).toMatchObject({ flags: ["seen"], bodyText: hydrated ? "Reply" : "" });
        expect(nested.conversation).toBe(conversation);
        expect(value.built).not.toBe(message);
        expect(value.built).toEqual({ id: "message", note: "kept" });
      },
    });
    await handler.restoreCompleted?.(
      ctx,
      { kind: "action", action: "setVariable", config: {}, sourcePath: ["steps", 0] } as WorkflowActionStep,
      { state: "completed", output },
    );
    expect(output.nested[0]?.message).not.toBe(message);
    expect(output.nested[0]?.conversation).not.toBe(conversation);
  });

  test("applies message transitions idempotently with stable keyword comparison", () => {
    const message = structuredClone(source.message);

    expect(applyMailMessageTransition(message, "addKeyword", "FINANCE")).toBe(false);
    expect(applyMailMessageTransition(message, "addKeyword", "Review")).toBe(true);
    expect(applyMailMessageTransition(message, "removeKeyword", "review")).toBe(true);
    expect(applyMailMessageTransition(message, "removeKeyword", "review")).toBe(false);
    expect(message.keywords).toEqual(["finance"]);
  });

  test("projects conversation revisions only when state changes", () => {
    if (!source.conversation) throw new Error("Expected workflow conversation fixture");
    const conversation = structuredClone(source.conversation);

    expect(applyMailConversationTransition(conversation, "setConversationStatus", "needs_action")).toBe(false);
    expect(applyMailConversationTransition(conversation, "setConversationStatus", "done")).toBe(true);
    expect(conversation).toMatchObject({ workStatus: "done", revision: 3 });
  });

  test("keeps stored single-user workflow actions as set replacement", () => {
    const conversation = { assigneeUserIds: ["first", "second"], revision: 1 };
    expect(applyMailConversationTransition(conversation, "assignConversation", "second")).toBeTrue();
    expect(conversation).toEqual({ assigneeUserIds: ["second"], revision: 2 });
    expect(applyMailConversationTransition(conversation, "assignConversation", "second")).toBeFalse();
    expect(applyMailConversationTransition(conversation, "assignConversation", null)).toBeTrue();
    expect(conversation).toEqual({ assigneeUserIds: [], revision: 3 });
    expect(applyMailConversationTransition(conversation, "assignConversation", null)).toBeFalse();
  });

  test("projects summary and summary revision independently", () => {
    if (!source.conversation) throw new Error("Expected workflow conversation fixture");
    const conversation = structuredClone(source.conversation);

    expect(applyMailConversationTransition(conversation, "setConversationSummary", "Current context")).toBe(true);
    expect(conversation).toMatchObject({ summary: "Current context", summaryRevision: 2, revision: 3 });
  });

  test("keeps schedule-only inputs when no message source exists", () => {
    const projected = createMailWorkflowProjectedState(plan, {}, { slot: "2026-07-22T08:00:00.000Z" });

    expect(projected.source).toEqual({});
    expect(projected.inputs).toEqual({ slot: "2026-07-22T08:00:00.000Z" });
  });

  test("evaluates a restored message action config at its live action path", async () => {
    const message: { id: string; flags: string[] } = { id: "message", flags: [] };
    const evaluate = mock(async (_value: WorkflowJsonValue, _path?: Array<string | number>) => ({ message }));
    const ctx = { evaluate } as unknown as WorkflowExecuteActionContext;
    const step: WorkflowActionStep = {
      kind: "action",
      action: "addFlag",
      config: { message: "${{ inputs.message }}", flag: "\\Seen" },
      sourcePath: ["steps", 1, "if", "then", 0],
    };

    await restoreMailWorkflowProjectedState(ctx, step, {
      state: "completed",
      output: { action: "addFlag", applied: true, value: "\\Seen" },
    });

    expect(evaluate.mock.calls).toEqual([[step.config, ["steps", 1, "if", "then", 0, "addFlag"]]]);
    expect(message.flags).toEqual(["\\Seen"]);
  });

  test("restores completed message and conversation projections before later steps", async () => {
    const projected = createMailWorkflowProjectedState(plan, source, {});
    const variables = new Map<string, unknown>();
    const ctx = {
      plan,
      variables: {
        get: (name: string) => variables.get(name),
        has: (name: string) => variables.has(name),
        set: (name: string, value: unknown) => variables.set(name, value),
      },
      evaluate: async (value: unknown) => value,
      resolveReference: async (reference: string) =>
        reference === "message" ? projected.inputs.message : reference === "conversation" ? projected.inputs.conversation : undefined,
    } as unknown as WorkflowExecuteActionContext;

    await restoreMailWorkflowProjectedState(
      ctx,
      { kind: "action", action: "moveMessage", config: { message: "message" }, sourcePath: ["steps", 0] } as WorkflowActionStep,
      { state: "completed", output: { action: "moveMessage", applied: true, value: "archive" } } as Extract<
        WorkflowStepOutcome,
        { state: "completed" }
      >,
    );
    await restoreMailWorkflowProjectedState(
      ctx,
      {
        kind: "action",
        action: "setConversationStatus",
        config: { conversation: "conversation" },
        sourcePath: ["steps", 1],
      } as WorkflowActionStep,
      {
        state: "completed",
        output: { action: "setConversationStatus", applied: true, value: "done", revision: 8 },
      } as Extract<WorkflowStepOutcome, { state: "completed" }>,
    );

    expect(projected.source.message.folderId).toBe("archive");
    expect(projected.source.conversation).toMatchObject({ workStatus: "done", revision: 8 });
  });

  test("restores the live status and revision from a status step that found its value already set", async () => {
    const projected = createMailWorkflowProjectedState(plan, source, {});
    const ctx = {
      plan,
      evaluate: async (value: unknown) => value,
      resolveReference: async (reference: string) => (reference === "conversation" ? projected.inputs.conversation : undefined),
    } as unknown as WorkflowExecuteActionContext;
    const step = {
      kind: "action",
      action: "setConversationStatus",
      config: { conversation: "conversation" },
      sourcePath: ["steps", 0],
    } as WorkflowActionStep;
    const completed = (output: Record<string, unknown>) =>
      ({ state: "completed", output }) as Extract<WorkflowStepOutcome, { state: "completed" }>;

    await restoreMailWorkflowProjectedState(ctx, step, completed({ action: "setConversationStatus", applied: false }));
    expect(projected.source.conversation).toMatchObject({ workStatus: "needs_action", revision: 2 });

    await restoreMailWorkflowProjectedState(
      ctx,
      step,
      completed({ action: "setConversationStatus", applied: false, value: "waiting", revision: 3 }),
    );
    expect(projected.source.conversation).toMatchObject({ workStatus: "waiting", revision: 3 });
  });
});

test("projected summaries preserve a person's text and revisions", () => {
  const conversation = { id: "conversation", summary: "My words", summarySource: "person", summaryRevision: 2, revision: 3 };
  expect(applyMailConversationTransition(conversation, "setConversationSummary", "AI text")).toBe(false);
  expect(conversation).toMatchObject({ summary: "My words", summaryRevision: 2, revision: 3 });
});
