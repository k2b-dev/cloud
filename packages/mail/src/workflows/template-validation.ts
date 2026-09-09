import type { WorkflowDiagnostic, WorkflowIr, WorkflowIrStep } from "@k2b/cloud/workflows";
import { workflowPathKey } from "@k2b/cloud/workflows";
import { validateMailLiquidTemplate } from "../service/template-rendering";

const TEMPLATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  addComment: ["body"],
  automaticReply: ["subject", "body"],
  createDraft: ["subject", "body"],
  createReplyDraft: ["body"],
  fail: ["message"],
  notifyUser: ["title", "body"],
  succeed: ["message"],
};

const validateSteps = (ir: WorkflowIr, steps: readonly WorkflowIrStep[], diagnostics: WorkflowDiagnostic[]): void => {
  for (const step of steps) {
    if (step.kind === "if") {
      validateSteps(ir, step.then, diagnostics);
      validateSteps(ir, step.else, diagnostics);
      continue;
    }
    if (step.kind === "switch") {
      for (const item of step.cases) validateSteps(ir, item.steps, diagnostics);
      validateSteps(ir, step.default, diagnostics);
      continue;
    }
    if (step.kind === "forEach") {
      validateSteps(ir, step.steps, diagnostics);
      continue;
    }

    for (const field of TEMPLATE_FIELDS[step.action] ?? []) {
      const value = step.config[field];
      if (typeof value !== "string") continue;
      const path = [...step.sourcePath, step.action, field];
      if (value.includes("${{")) {
        diagnostics.push({
          code: "MAIL_TEMPLATE_LEGACY_SYNTAX",
          message: `Use Liquid "{{ value }}" syntax in ${step.action}.${field}; "\${{ value }}" is reserved for typed workflow values`,
          severity: "error",
          path,
          location: ir.sourceLocations[workflowPathKey(path)],
        });
        continue;
      }
      const valid = validateMailLiquidTemplate(value, {
        output:
          field === "body" &&
          (step.action === "automaticReply" || step.action === "createDraft" || step.action === "createReplyDraft") &&
          step.config.format !== "plain"
            ? "markdown"
            : "text",
      });
      if (!valid.ok) {
        diagnostics.push({
          code: "MAIL_TEMPLATE_INVALID",
          message: valid.error.message,
          severity: "error",
          path,
          location: ir.sourceLocations[workflowPathKey(path)],
        });
      }
    }
  }
};

export const validateMailWorkflowTemplates = (ir: WorkflowIr): WorkflowDiagnostic[] => {
  const diagnostics: WorkflowDiagnostic[] = [];
  validateSteps(ir, ir.steps, diagnostics);
  return diagnostics;
};
