import type { WorkflowActionStep, WorkflowExecuteActionContext } from "@k2b/cloud/workflows/runtime";
import { MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS, mailWorkflowTemplateOutput } from "../workflows/template-validation";
import { mailWorkflowTemplateData, renderMailLiquidTemplate } from "./template-rendering";
import { withMailWorkflowBodyGuard } from "./workflow-body-fields";

export const resolveMailWorkflowTemplateBodies = async (ctx: WorkflowExecuteActionContext, step: WorkflowActionStep): Promise<void> => {
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
    const data = mailWorkflowTemplateData({
      invocation: ctx.invocation,
      variableSnapshot: () => ctx.variables.snapshot?.() ?? {},
    });
    // Load the first unloaded body the render reads, then render again: earlier bodies can change branches.
    // Each pass loads one more field, so the passes are bounded by the body fields of the inputs.
    const maxPasses = Object.keys(ctx.invocation.inputs).length * 3 + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      // Other render errors end probing and are reported by the real renderer.
      const probe = withMailWorkflowBodyGuard(ctx.invocation.inputs, () => renderMailLiquidTemplate(source, data, output));
      if (probe.unloaded === undefined) break;
      const value = await ctx.resolveReference(probe.unloaded, [...step.sourcePath, step.action, templateField]);
      if (value === undefined) throw new Error(`Mail workflow value unavailable: ${probe.unloaded}`);
    }
  }
};
