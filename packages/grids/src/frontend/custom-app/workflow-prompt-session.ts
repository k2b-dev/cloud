import { z } from "zod";
import { CustomAppPromptValuesSchema } from "../../custom-apps/workflow-prompt";
import type { CustomAppWorkflowOperation } from "./workflow-action-client";

export const WORKFLOW_PROMPT_ATTEMPT_CHANGED = "grids:workflow-prompt-attempt-changed";
const storedActionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    icon: z.string().optional(),
    endpoint: z.string().startsWith("/api/grids/apps/runtime/"),
    launcherId: z.string().min(1),
    successMessage: z.string().optional(),
  })
  .strict();
export type StoredWorkflowPromptAction = z.infer<typeof storedActionSchema>;
const storedAttemptSchema = z
  .object({
    action: storedActionSchema,
    operation: z.object({ operationId: z.string().uuid(), statusUrl: z.string().startsWith("/api/grids/").optional() }).strict(),
    inputs: CustomAppPromptValuesSchema,
  })
  .strict();
export type StoredWorkflowPromptAttempt = z.infer<typeof storedAttemptSchema>;

export const workflowPromptSessionKey = (scope: string, endpoint: string) => `grids:workflow-prompt:${scope}:${endpoint}`;
export const readWorkflowPromptAttempt = (key: string) => {
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return undefined;
  const parsed = storedAttemptSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || !key.endsWith(`:${parsed.data.action.endpoint}`)) throw new Error("Stored workflow attempt is invalid");
  return parsed.data;
};
export const storeWorkflowPromptAttempt = (
  key: string,
  action: StoredWorkflowPromptAction,
  operation: CustomAppWorkflowOperation,
  inputs: Record<string, unknown>,
) => {
  window.sessionStorage.setItem(key, JSON.stringify({ action, operation, inputs }));
  window.dispatchEvent(new Event(WORKFLOW_PROMPT_ATTEMPT_CHANGED));
};
export const clearWorkflowPromptAttempt = (key: string) => {
  window.sessionStorage.removeItem(key);
  window.dispatchEvent(new Event(WORKFLOW_PROMPT_ATTEMPT_CHANGED));
};

const pageIdentity = (path: string) => {
  const url = new URL(path, "http://local.invalid");
  const segments = url.pathname.split("/").filter(Boolean);
  const parts = url.pathname.startsWith("/api/grids/apps/runtime/") ? segments.slice(4, 6) : segments.slice(1, 3);
  url.searchParams.sort();
  return `${parts.join("/")}?${url.searchParams}`;
};
export const listWorkflowPromptAttempts = (scope: string, pagePath: string) => {
  const prefix = `grids:workflow-prompt:${scope}:`;
  const attempts: StoredWorkflowPromptAttempt[] = [];
  for (let index = 0; index < window.sessionStorage.length; index++) {
    const key = window.sessionStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const attempt = readWorkflowPromptAttempt(key);
    if (attempt && pageIdentity(attempt.action.endpoint) === pageIdentity(pagePath)) attempts.push(attempt);
  }
  return attempts;
};
