import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import { MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS } from "../workflows/template-validation";
import { mailWorkflowTemplateData, renderMailLiquidTemplate } from "./template-rendering";

const BODY_FIELDS = ["body", "bodyText", "bodyHtml"] as const;

export const resolveMailWorkflowTemplateBodies = async (ctx: WorkflowExecuteActionContext, step: WorkflowActionStep): Promise<void> => {
  for (const templateField of MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS[step.action] ?? []) {
    const source = step.config[templateField];
    if (typeof source !== "string") continue;
    const inputs = { ...ctx.invocation.inputs };
    const accessed = new Set<string>();
    let maxReferences = 0;
    for (const input of ctx.plan.inputs) {
      const message = inputs[input.name];
      if (input.type !== "mailMessage" || !message || typeof message !== "object" || Array.isArray(message)) continue;
      const recording = { ...message };
      for (const field of BODY_FIELDS) {
        Object.defineProperty(recording, field, {
          enumerable: true,
          get: () => {
            accessed.add(`inputs.${input.name}.${field}`);
            return message[field];
          },
        });
      }
      inputs[input.name] = recording;
      maxReferences += BODY_FIELDS.length;
    }
    const data = mailWorkflowTemplateData({
      invocation: { ...ctx.invocation, inputs },
      variableSnapshot: () => ctx.variables.snapshot?.() ?? {},
    });
    const resolved = new Set<string>();
    // Each productive pass resolves a new field; one final pass confirms there are no more accesses.
    for (let pass = 0; pass <= maxReferences; pass++) {
      // Only escaping differs in text mode. The real renderer reports any errors and produces the output.
      renderMailLiquidTemplate(source, data, "text");
      const pending = [...accessed].filter((reference) => !resolved.has(reference));
      if (pending.length === 0) break;
      for (const reference of pending) {
        const value = await ctx.resolveReference(reference, [...step.sourcePath, step.action, templateField]);
        if (value === undefined) throw new Error(`Mail workflow value unavailable: ${reference}`);
        resolved.add(reference);
      }
    }
  }
};
