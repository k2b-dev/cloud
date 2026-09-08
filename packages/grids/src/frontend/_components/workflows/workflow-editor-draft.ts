import type { PublicWorkflow } from "../workspace/workspace-public-state-model";

export type WorkflowEditorDraft = {
  name: string;
  description: string;
  enabled: boolean;
  source: string;
  revision: number;
};

type WorkflowEditorSavePayload = {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  source?: string;
};

export const workflowEditorDraft = (workflow: PublicWorkflow | undefined, fallbackSource: string): WorkflowEditorDraft => ({
  name: workflow?.name ?? "",
  description: workflow?.description ?? "",
  enabled: workflow?.enabled ?? false,
  source: workflow?.source ?? fallbackSource,
  revision: workflow?.revision ?? 1,
});

const normalizedEditableFields = (draft: WorkflowEditorDraft) => ({
  name: draft.name.trim(),
  description: draft.description.trim() || null,
  enabled: draft.enabled,
  source: draft.source,
});

export const workflowEditorSavePayload = (
  current: WorkflowEditorDraft,
  clean: WorkflowEditorDraft,
  creating: boolean,
): WorkflowEditorSavePayload => {
  const next = normalizedEditableFields(current);
  if (creating) return next;

  const previous = normalizedEditableFields(clean);
  return {
    ...(next.name !== previous.name ? { name: next.name } : {}),
    ...(next.description !== previous.description ? { description: next.description } : {}),
    ...(next.enabled !== previous.enabled ? { enabled: next.enabled } : {}),
    ...(next.source !== previous.source ? { source: next.source } : {}),
  };
};

export const workflowEditorDraftDirty = (current: WorkflowEditorDraft, clean: WorkflowEditorDraft): boolean =>
  Object.keys(workflowEditorSavePayload(current, clean, false)).length > 0;
