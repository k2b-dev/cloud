import { describe, expect, mock, test } from "bun:test";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import { renderMailWorkflowTemplate } from "./template-rendering";
import { resolveMailWorkflowTemplateBodies } from "./workflow-template-values";

const step = (message: string): WorkflowActionStep => ({
  kind: "action",
  action: "succeed",
  config: { message },
  sourcePath: ["steps", 0],
});

const fixture = () => {
  const message = { id: "msg001", body: "", bodyText: "", bodyHtml: "", bodyAvailable: false };
  const bodies: Record<string, WorkflowJsonValue> = { body: "x plain", bodyText: "x plain", bodyHtml: "<p>HTML</p>" };
  const resolveReference = mock(async (reference: string, _path?: Array<string | number>) => {
    const field = reference.split(".")[2];
    const value = field ? bodies[field] : undefined;
    if (field && value !== undefined) {
      Object.assign(message, { [field]: value });
      if (field === "body" || field === "bodyText") message.body = message.bodyText = String(value);
    }
    return value;
  });
  const run = {
    runId: "run",
    executionGeneration: 1,
    mode: "execute" as const,
    workflowId: "workflow",
    sourceHash: "source",
    idempotencyKey: "fixture",
  };
  const ctx: WorkflowExecuteActionContext = {
    mode: "execute",
    run,
    step: { ...run, key: "step", sourcePath: ["steps", 0], iterationPath: [], path: ["steps", 0], kind: "action" },
    plan: {
      schemaVersion: 2,
      languageId: "mail",
      languageVersion: 1,
      sourceHash: "source",
      manifestHash: "manifest",
      catalogHash: "catalog",
      actionPolicies: {},
      inputs: [{ name: "message", type: "mailMessage", config: {} }],
      triggers: [],
      steps: [],
      bindings: {},
    },
    invocation: {
      workflowId: "workflow",
      mode: "execute",
      channel: "event",
      actor: { userId: "user" },
      inputs: { message },
      context: { mailboxId: "mailbox" },
      idempotencyKey: "fixture",
      occurredAt: "2026-10-01T08:00:00.000Z",
    },
    variables: { get: () => undefined, has: () => false, set: () => {}, snapshot: () => ({ field: "bodyText" }) },
    evaluate: async (value) => value,
    resolveReference,
    heartbeat: async () => {},
  };
  return { ctx, message, resolveReference };
};

describe("Mail workflow template body access", () => {
  test("does not resolve bodies in untaken branches", async () => {
    const { ctx, message, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, step("{% if false %}{{ inputs.message.bodyText }}{% else %}OK{% endif %}"));
    expect(resolveReference).not.toHaveBeenCalled();
    expect(message).toEqual({ id: "msg001", body: "", bodyText: "", bodyHtml: "", bodyAvailable: false });
    expect(Object.getOwnPropertyDescriptor(message, "bodyText")?.get).toBeUndefined();
  });

  test("resolves computed body lookups", async () => {
    const { ctx, message, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, step("{% assign field = 'bodyText' %}{{ inputs.message[field] }}"));
    expect(resolveReference.mock.calls).toEqual([["inputs.message.bodyText", ["steps", 0, "succeed", "message"]]]);
    expect(message.bodyText).toBe("x plain");
  });

  test("records body access through a Liquid alias", async () => {
    const { ctx, message, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, step("{% assign m = inputs.message %}{{ m.body }}"));
    expect(resolveReference.mock.calls).toEqual([["inputs.message.body", ["steps", 0, "succeed", "message"]]]);
    expect(message.body).toBe("x plain");
  });

  test("resolves newly reached body fields across passes", async () => {
    const { ctx, message, resolveReference } = fixture();
    const source = '{% if inputs.message.bodyText contains "x" %}{{ inputs.message.bodyHtml }}{% endif %}';
    await resolveMailWorkflowTemplateBodies(ctx, step(source));
    expect(resolveReference.mock.calls).toEqual([
      ["inputs.message.bodyText", ["steps", 0, "succeed", "message"]],
      ["inputs.message.bodyHtml", ["steps", 0, "succeed", "message"]],
    ]);
    expect(message.bodyHtml).toBe("<p>HTML</p>");
    expect(renderMailWorkflowTemplate({ invocation: ctx.invocation, variableSnapshot: () => ({}) }, source)).toBe("<p>HTML</p>");
  });

  test("fails visibly when a present message body cannot be resolved", async () => {
    const { ctx, resolveReference } = fixture();
    resolveReference.mockResolvedValue(undefined);
    await expect(resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message.body }}"))).rejects.toThrow("inputs.message.body");
  });

  test("does not resolve a body of an absent optional input", async () => {
    const { ctx, resolveReference } = fixture();
    delete ctx.invocation.inputs.message;
    await resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message.body }}"));
    expect(resolveReference).not.toHaveBeenCalled();
  });

  test("templates without body access do not resolve references", async () => {
    const { ctx, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message.id }} / {{ context.actor.userId }} / {{ context.occurredAt }}"));
    expect(resolveReference).not.toHaveBeenCalled();
  });

  test("uses the variable snapshot when choosing a body field", async () => {
    const { ctx, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message[field] }}"));
    expect(resolveReference.mock.calls).toEqual([["inputs.message.bodyText", ["steps", 0, "succeed", "message"]]]);
  });

  test("propagates resolver waiting errors", async () => {
    const { ctx, resolveReference } = fixture();
    const waiting = new Error("Waiting for Mail hydration");
    resolveReference.mockRejectedValue(waiting);
    await expect(resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message.body }}"))).rejects.toBe(waiting);
  });

  test("records declared action template fields with their source paths", async () => {
    const { ctx, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, {
      kind: "action",
      action: "automaticReply",
      config: { subject: "{{ inputs.message.bodyText }}", body: "{{ inputs.message.bodyHtml }}", format: "markdown" },
      sourcePath: ["steps", 2],
    });
    expect(resolveReference.mock.calls).toEqual([
      ["inputs.message.bodyText", ["steps", 2, "automaticReply", "subject"]],
      ["inputs.message.bodyHtml", ["steps", 2, "automaticReply", "body"]],
    ]);
  });
});
