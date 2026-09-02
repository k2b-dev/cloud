import type { MandatePolicyV1 } from "@valentinkolb/cloud/services";
import type { MailAutomationStep } from "../contracts";

export type IncomingAutomationAuthorityMode = "legacy" | "mandate";

export const incomingAutomationAuthorityMode = (
  value = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE,
): IncomingAutomationAuthorityMode => {
  const mode = value?.trim() || "legacy";
  if (mode === "legacy" || mode === "mandate") return mode;
  throw new Error("CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE must be legacy or mandate");
};

const visitSteps = (steps: MailAutomationStep[], visit: (step: MailAutomationStep) => void): void => {
  for (const step of steps) {
    visit(step);
    if (step.kind !== "if") continue;
    visitSteps(step.then, visit);
    visitSteps(step.else, visit);
  }
};

export const incomingAutomationMandatePolicy = (steps: MailAutomationStep[]): MandatePolicyV1 | null => {
  const operations = new Set<string>();
  visitSteps(steps, (step) => {
    if (step.kind === "link_space_item") operations.add("capability.action.run:item.reference.add");
    if (step.kind === "create_space_event") operations.add("capability.action.run:event.create-once");
  });
  if (operations.size === 0) return null;
  return {
    version: 1,
    apps: ["spaces"],
    operations: [...operations].sort(),
    actions: "preapproved",
  };
};
