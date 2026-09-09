import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { PublicEmailTemplate } from "../../../api/public-email-templates";

type WorkflowEmailTemplateDraft = {
  name: string;
  description: string;
  subject: string;
  html: string;
  sampleData: Record<string, WorkflowJsonValue>;
  enabled: boolean;
};

export const workflowEmailTemplateDraft = (
  template: PublicEmailTemplate | undefined,
  defaultSubject: string,
  defaultHtml: string,
  defaultSampleData: Record<string, WorkflowJsonValue>,
): WorkflowEmailTemplateDraft => ({
  name: template?.name ?? "",
  description: template?.description ?? "",
  subject: template?.subject ?? defaultSubject,
  html: template?.html ?? defaultHtml,
  sampleData: template?.sampleData ?? defaultSampleData,
  enabled: template?.enabled ?? true,
});

export const workflowEmailTemplateDraftDirty = (current: WorkflowEmailTemplateDraft, clean: WorkflowEmailTemplateDraft): boolean =>
  current.name !== clean.name ||
  current.description !== clean.description ||
  current.subject !== clean.subject ||
  current.html !== clean.html ||
  JSON.stringify(current.sampleData) !== JSON.stringify(clean.sampleData) ||
  current.enabled !== clean.enabled;
