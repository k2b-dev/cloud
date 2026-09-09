import {
  buildWorkflowAutocompleteCompletions,
  type WorkflowAutocompleteRequest,
  workflowCompletionItemToSuggestion,
} from "@k2b/cloud/workflows/editor";
import type { WorkflowAutocompleteResponse } from "../../../workflows/contracts";

export type { WorkflowAutocompleteRequest };
export const toSuggestion = workflowCompletionItemToSuggestion;
export const buildBackendWorkflowCompletions = (config: {
  fetchAutocomplete: (request: WorkflowAutocompleteRequest, signal: AbortSignal) => Promise<WorkflowAutocompleteResponse>;
  onDiagnostics?: (response: WorkflowAutocompleteResponse) => void;
}) =>
  buildWorkflowAutocompleteCompletions({
    fetchAutocomplete: config.fetchAutocomplete,
    onResponse: config.onDiagnostics,
  });
