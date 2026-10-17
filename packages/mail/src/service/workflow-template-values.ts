import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import { MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS, mailWorkflowTemplateOutput } from "../workflows/template-validation";
import { mailWorkflowTemplateData, renderMailLiquidTemplate } from "./template-rendering";

const BODY_FIELDS = ["body", "bodyText", "bodyHtml"] as const;

export const resolveMailWorkflowTemplateBodies = async (ctx: WorkflowExecuteActionContext, step: WorkflowActionStep): Promise<void> => {
  const unresolvedBody = Symbol("unresolved Mail workflow body");
  for (const templateField of MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS[step.action] ?? []) {
    const rawValue = step.config[templateField];
    if (rawValue === undefined) continue;
    const source = await ctx.evaluate(rawValue, [...step.sourcePath, step.action, templateField]);
    if (typeof source !== "string") continue;
    const rawFormat = step.config.format;
    const format =
      templateField === "body" && rawFormat !== undefined
        ? await ctx.evaluate(rawFormat, [...step.sourcePath, step.action, "format"])
        : rawFormat;
    const output = mailWorkflowTemplateOutput(step.action, templateField, format);
    const inputs = { ...ctx.invocation.inputs };
    const resolved = new Set<string>();
    const recordings = new Map<Record<string, WorkflowJsonValue>, Record<string, WorkflowJsonValue>>();
    let pendingReference: string | undefined;
    for (const input of ctx.plan.inputs) {
      const message = inputs[input.name];
      if (input.type !== "mailMessage" || !message || typeof message !== "object" || Array.isArray(message)) continue;
      const existing = recordings.get(message);
      if (existing) {
        inputs[input.name] = existing;
        continue;
      }
      const recording = { ...message };
      for (const field of BODY_FIELDS) {
        const reference = `inputs.${input.name}.${field}`;
        Object.defineProperty(recording, field, {
          enumerable: true,
          get: () => {
            if (!resolved.has(reference)) {
              pendingReference = reference;
              throw unresolvedBody;
            }
            return message[field];
          },
        });
      }
      recordings.set(message, recording);
      inputs[input.name] = recording;
    }
    const data = mailWorkflowTemplateData({
      invocation: { ...ctx.invocation, inputs },
      variableSnapshot: () => ctx.variables.snapshot?.() ?? {},
    });
    // Each productive pass resolves a new field; one final pass confirms there are no more accesses.
    const maxReferences = recordings.size * BODY_FIELDS.length;
    for (let pass = 0; pass <= maxReferences; pass++) {
      pendingReference = undefined;
      // The renderer wraps the sentinel; the local reference identifies it without inspecting errors.
      // Other render errors end probing and are reported by the real renderer.
      renderMailLiquidTemplate(source, data, output);
      if (pendingReference === undefined) break;
      const value = await ctx.resolveReference(pendingReference, [...step.sourcePath, step.action, templateField]);
      if (value === undefined) throw new Error(`Mail workflow value unavailable: ${pendingReference}`);
      resolved.add(pendingReference);
    }
  }
};
