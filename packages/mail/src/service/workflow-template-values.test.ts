import { describe, expect, mock, test } from "bun:test";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import { MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS, mailWorkflowTemplateOutput } from "../workflows/template-validation";
import { renderMailWorkflowTemplate } from "./template-rendering";
import { markMailWorkflowBodyFieldsLoaded } from "./workflow-body-fields";
import { projectMailWorkflowFrozenMessage } from "./workflow-runtime-values";
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
      // Like the resolver: project the loaded value in place and mark it loaded.
      Object.assign(message, { [field]: value });
      if (field === "body" || field === "bodyText") message.body = message.bodyText = String(value);
      markMailWorkflowBodyFieldsLoaded(message, field === "bodyHtml" ? ["bodyHtml"] : ["body", "bodyText"]);
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
  const evaluate = mock(async (value: WorkflowJsonValue, _path?: Array<string | number>) => value);
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
    evaluate,
    resolveReference,
    heartbeat: async () => {},
  };
  return { ctx, message, evaluate, resolveReference };
};

describe("Mail workflow template body access", () => {
  test("preserves message identity between the variable snapshot and inputs", async () => {
    const { ctx, message, resolveReference } = fixture();
    ctx.variables.snapshot = () => ({ selected: message });
    const source = "{% if selected == inputs.message %}OK{% else %}{{ inputs.message.bodyText }}{% endif %}";

    await resolveMailWorkflowTemplateBodies(ctx, step(source));

    expect(resolveReference).not.toHaveBeenCalled();
    expect(ctx.invocation.inputs.message).toBe(message);
    expect(renderMailWorkflowTemplate({ invocation: ctx.invocation, variableSnapshot: ctx.variables.snapshot }, source)).toBe("OK");
  });

  test.each(["unread", "resolved", "unavailable", "render error"])("restores plain body properties after an %s probe", async (scenario) => {
    const { ctx, message, resolveReference } = fixture();
    const expectPlainBodies = () => {
      for (const field of ["body", "bodyText", "bodyHtml"] as const) {
        expect(Object.getOwnPropertyDescriptor(message, field)).toEqual({
          value: message[field],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    };
    const resolve = resolveReference.getMockImplementation()!;
    resolveReference.mockImplementation(async (reference, path) => {
      expectPlainBodies(); // Getters must be gone before the resolver can suspend.
      return scenario === "unavailable" ? undefined : resolve(reference, path);
    });
    const source =
      scenario === "unread"
        ? "OK"
        : scenario === "render error"
          ? "{{ inputs.message.bodyText | pad_start: 0 }}{{ inputs.message.bodyHtml }}"
          : "{{ inputs.message.bodyText }}";
    const probe = resolveMailWorkflowTemplateBodies(ctx, step(source));
    if (scenario === "unavailable") await expect(probe).rejects.toThrow("inputs.message.bodyText");
    else await probe;

    expectPlainBodies();
    expect(message).toEqual({
      id: "msg001",
      body: scenario === "resolved" || scenario === "render error" ? "x plain" : "",
      bodyText: scenario === "resolved" || scenario === "render error" ? "x plain" : "",
      bodyHtml: "",
      bodyAvailable: false,
    });
  });

  test("uses bodies already available on an older event without resolving them", async () => {
    const { ctx, message, resolveReference } = fixture();
    Object.assign(message, { body: "Old text", bodyText: "Old text", bodyHtml: "<p>Old HTML</p>", bodyAvailable: true });
    await resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message.bodyText }} / {{ inputs.message.bodyHtml }}"));
    expect(resolveReference).not.toHaveBeenCalled();
  });

  test("uses a frozen empty body projected through an aliased input without resolving it again", async () => {
    const { ctx, message, resolveReference } = fixture();
    ctx.plan.inputs.push({ name: "second", type: "mailMessage", config: {} });
    ctx.invocation.inputs.second = message;
    projectMailWorkflowFrozenMessage("second", message, { "inputs.second.bodyText": "" });

    await resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.second.bodyText }}"));

    expect(resolveReference).not.toHaveBeenCalled();
  });

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

  test.each(["first", "second"])("preserves shared message identity when reading the %s input body", async (name) => {
    const { ctx, message, resolveReference } = fixture();
    ctx.plan.inputs = [
      { name: "first", type: "mailMessage", config: {} },
      { name: "second", type: "mailMessage", config: {} },
    ];
    ctx.invocation.inputs = { first: message, second: message };
    const source = `{% if inputs.first == inputs.second %}{{ inputs.${name}.bodyText }}{% endif %}`;

    await resolveMailWorkflowTemplateBodies(ctx, step(source));

    expect(resolveReference.mock.calls).toEqual([["inputs.first.bodyText", ["steps", 0, "succeed", "message"]]]);
    expect(ctx.invocation.inputs.first).toBe(ctx.invocation.inputs.second);
    expect(message.bodyText).toBe("x plain");
    expect(renderMailWorkflowTemplate({ invocation: ctx.invocation, variableSnapshot: () => ({}) }, source)).toBe("x plain");
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

  test("replays frozen bodyText before choosing a branch without resolving unavailable HTML", async () => {
    const { ctx, message, resolveReference } = fixture();
    // Replay restores the frozen text when its reference is resolved, even if the original message is gone.
    resolveReference.mockImplementation(async (reference) => {
      if (reference !== "inputs.message.bodyText") return undefined;
      message.body = message.bodyText = "x frozen plain";
      markMailWorkflowBodyFieldsLoaded(message, ["body", "bodyText"]);
      return message.bodyText;
    });
    const source = '{% if inputs.message.bodyText contains "x" %}OK{% else %}{{ inputs.message.bodyHtml }}{% endif %}';
    await resolveMailWorkflowTemplateBodies(ctx, step(source));
    expect(resolveReference.mock.calls).toEqual([["inputs.message.bodyText", ["steps", 0, "succeed", "message"]]]);
    expect(renderMailWorkflowTemplate({ invocation: ctx.invocation, variableSnapshot: () => ({}) }, source)).toBe("OK");
  });

  test("evaluates a typed config expression before probing its Liquid template", async () => {
    const { ctx, evaluate, resolveReference } = fixture();
    evaluate.mockImplementation(async (value) => (value === "${{ tmpl }}" ? "{{ inputs.message.bodyText }}" : value));
    await resolveMailWorkflowTemplateBodies(ctx, {
      kind: "action",
      action: "setConversationSummary",
      config: { summary: "${{ tmpl }}" },
      sourcePath: ["steps", 1],
    });
    expect(evaluate).toHaveBeenCalledWith("${{ tmpl }}", ["steps", 1, "setConversationSummary", "summary"]);
    expect(resolveReference.mock.calls).toEqual([["inputs.message.bodyText", ["steps", 1, "setConversationSummary", "summary"]]]);
  });

  test("skips config expressions that evaluate to a non-string", async () => {
    const { ctx, evaluate, resolveReference } = fixture();
    evaluate.mockResolvedValue(null);
    await resolveMailWorkflowTemplateBodies(ctx, step("${{ tmpl }}"));
    expect(resolveReference).not.toHaveBeenCalled();
  });

  test.each(["automaticReply", "createDraft", "createReplyDraft"])("probes %s with its evaluated output mode", async (action) => {
    const { ctx, message, evaluate, resolveReference } = fixture();
    message.id = "msg_001";
    evaluate.mockImplementation(async (value) => (value === "${{ replyFormat }}" ? "markdown" : value));
    // Captured output is escaped in the action's mode and then controls which branch is taken.
    const marker = action === "automaticReply" ? "&#95;" : "\\_";
    const body = `{% capture id %}{{ inputs.message.id }}{% endcapture %}{% if id contains '${marker}' %}{{ inputs.message.bodyText }}{% endif %}`;
    await resolveMailWorkflowTemplateBodies(ctx, {
      kind: "action",
      action,
      config: { body, format: "${{ replyFormat }}" },
      sourcePath: ["steps", 0],
    });
    expect(evaluate).toHaveBeenCalledWith("${{ replyFormat }}", ["steps", 0, action, "format"]);
    expect(resolveReference.mock.calls).toEqual([["inputs.message.bodyText", ["steps", 0, action, "body"]]]);
  });

  test("ends probing on a render error without resolving later body fields", async () => {
    const { ctx, resolveReference } = fixture();
    await resolveMailWorkflowTemplateBodies(ctx, step("{{ inputs.message.bodyText | pad_start: 0 }}{{ inputs.message.bodyHtml }}"));
    expect(resolveReference.mock.calls).toEqual([["inputs.message.bodyText", ["steps", 0, "succeed", "message"]]]);
    expect(() =>
      renderMailWorkflowTemplate(
        { invocation: ctx.invocation, variableSnapshot: () => ({}) },
        "{{ inputs.message.bodyText | pad_start: 0 }}{{ inputs.message.bodyHtml }}",
      ),
    ).toThrow("pad_start width");
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

describe("Mail workflow template output modes", () => {
  test.each(["plain", "markdown", undefined, "unexpected"])("maps every template field with format %s", (format) => {
    expect(mailWorkflowTemplateOutput("automaticReply", "body", format)).toBe(format === "markdown" ? "markdown" : "text");
    for (const action of ["createDraft", "createReplyDraft"]) {
      expect(mailWorkflowTemplateOutput(action, "body", format)).toBe(format === "plain" ? "text" : "editable_markdown");
    }
    for (const [action, fields] of Object.entries(MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS)) {
      for (const field of fields) {
        if (field === "body" && ["automaticReply", "createDraft", "createReplyDraft"].includes(action)) continue;
        expect(mailWorkflowTemplateOutput(action, field, format)).toBe("text");
      }
    }
  });
});

describe("Mail workflow template rendering guard", () => {
  test("fails visibly when the real render reads a body the probe did not load", () => {
    const message = { id: "msg001", body: "", bodyText: "", bodyHtml: "", bodyAvailable: false };
    const context = {
      invocation: {
        workflowId: "workflow",
        mode: "execute" as const,
        channel: "event" as const,
        actor: {},
        inputs: { message },
        idempotencyKey: "guard",
        occurredAt: "2026-10-01T08:00:00.000Z",
      },
      variableSnapshot: () => ({}),
    };
    expect(() => renderMailWorkflowTemplate(context, "Body: {{ inputs.message.bodyText }}")).toThrow(
      "Mail workflow value was not loaded: inputs.message.bodyText",
    );
    expect(renderMailWorkflowTemplate(context, "Subject only")).toBe("Subject only");
    expect(Object.getOwnPropertyDescriptor(message, "bodyText")).toMatchObject({ value: "", writable: true });
    markMailWorkflowBodyFieldsLoaded(message, ["body", "bodyText"]);
    expect(renderMailWorkflowTemplate(context, "Body: {{ inputs.message.bodyText }}")).toBe("Body: ");
  });
});

test.each(["textLength", "attachmentCount"] as const)("templates wait for %s instead of rendering an unloaded metric", async (field) => {
  const { ctx, message } = fixture();
  let reads = 0;
  ctx.resolveReference = async (reference) => {
    expect(reference).toBe(`inputs.message.${field}`);
    reads += 1;
    projectMailWorkflowFrozenMessage(
      "message",
      message,
      field === "textLength"
        ? { "inputs.message.bodyText": "Reply\n\n-- \nSignature" }
        : { "inputs.message.attachments": [{ id: "att001" }] },
    );
    return field === "textLength" ? 5 : 1;
  };
  const source = `Count {{ inputs.message.${field} }}`;
  await resolveMailWorkflowTemplateBodies(ctx, step(source));
  expect(reads).toBe(1);
  expect(renderMailWorkflowTemplate({ invocation: ctx.invocation, variableSnapshot: () => ({}) }, source)).toBe(
    `Count ${field === "textLength" ? 5 : 1}`,
  );
});
