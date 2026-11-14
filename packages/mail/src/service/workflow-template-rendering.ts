import type { WorkflowActionContext, WorkflowJsonValue } from "@k2b/cloud/workflows";
import { type MailTemplateOutput, renderMailLiquidTemplate } from "./template-rendering";
import { withMailWorkflowBodyGuard } from "./workflow-body-fields";

export const mailWorkflowTemplateData = (
  context: Pick<WorkflowActionContext, "invocation" | "variableSnapshot">,
): Record<string, WorkflowJsonValue> => ({
  inputs: context.invocation.inputs,
  context: {
    ...(context.invocation.context ?? {}),
    actor: context.invocation.actor,
    occurredAt: context.invocation.occurredAt,
  },
  ...context.variableSnapshot(),
});

export const renderMailWorkflowTemplate = (
  context: Pick<WorkflowActionContext, "invocation" | "variableSnapshot">,
  source: string,
  output: MailTemplateOutput = "text",
): string => {
  const guarded = withMailWorkflowBodyGuard(context.invocation.inputs, () =>
    renderMailLiquidTemplate(source, mailWorkflowTemplateData(context), output),
  );
  // The step loads every body its template reads before it runs; a body still missing here fails visibly.
  if (guarded.unloaded !== undefined) throw new Error(`Mail workflow value was not loaded: ${guarded.unloaded}`);
  if (!guarded.result.ok) throw guarded.result.error;
  return guarded.result.data;
};

export const migrateWorkflowTextTemplateToLiquid = (source: string): string =>
  source.replace(/\$\{\{([^{}]+)\}\}/g, (_match, expression: string) => `{{ ${expression.trim()} }}`);
