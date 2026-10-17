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
    const resolved = new Set<string>();
    const messages = new Map<Record<string, WorkflowJsonValue>, string>();
    let pendingReference: string | undefined;
    for (const input of ctx.plan.inputs) {
      const message = ctx.invocation.inputs[input.name];
      if (input.type !== "mailMessage" || !message || typeof message !== "object" || Array.isArray(message)) continue;
      if (!messages.has(message)) messages.set(message, input.name);
    }
    const data = mailWorkflowTemplateData({
      invocation: ctx.invocation,
      variableSnapshot: () => ctx.variables.snapshot?.() ?? {},
    });
    // Each productive pass resolves a new field; one final pass confirms there are no more accesses.
    const maxReferences = messages.size * BODY_FIELDS.length;
    for (let pass = 0; pass <= maxReferences; pass++) {
      pendingReference = undefined;
      const restore: Array<() => void> = [];
      try {
        for (const [message, name] of messages) {
          for (const field of BODY_FIELDS) {
            const value = message[field];
            const reference = `inputs.${name}.${field}`;
            Object.defineProperty(message, field, {
              enumerable: true,
              configurable: true,
              get: () => {
                if (resolved.has(reference) || message.bodyAvailable === true) return value;
                pendingReference = reference;
                throw unresolvedBody;
              },
            });
            restore.push(() => Object.defineProperty(message, field, { value, writable: true, enumerable: true, configurable: true }));
          }
        }
        // The renderer wraps the sentinel; the local reference identifies it without inspecting errors.
        // Other render errors end probing and are reported by the real renderer.
        renderMailLiquidTemplate(source, data, output);
      } finally {
        // Restore real objects before resolution can suspend or update their bodies.
        for (const field of restore) field();
      }
      if (pendingReference === undefined) break;
      const value = await ctx.resolveReference(pendingReference, [...step.sourcePath, step.action, templateField]);
      if (value === undefined) throw new Error(`Mail workflow value unavailable: ${pendingReference}`);
      resolved.add(pendingReference);
    }
  }
};
