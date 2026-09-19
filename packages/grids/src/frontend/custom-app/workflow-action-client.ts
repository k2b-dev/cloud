import { WorkflowPendingDocumentConfirmationSchema } from "../../workflows/query-contracts";

export type CustomAppWorkflowOutcome = {
  kind: "running" | "success" | "error";
  message: string;
  navigateTo?: string;
};

/** A rejected start has no committed workflow; its inputs may be corrected. */
export class CustomAppWorkflowStartRejected extends Error {}

/** Retain this handle while the outcome is unknown; retries must not create a second run. */
export type CustomAppWorkflowOperation = { operationId: string; statusUrl?: string };

type CustomAppWorkflowMessages = {
  startFailed: string;
  statusUnavailable: string;
  completed: string;
  failed: string;
  stillRunning: string;
  awaitingExport?: string;
};

const defaultMessages: CustomAppWorkflowMessages = {
  startFailed: "The workflow could not be started.",
  statusUnavailable: "The workflow status is unavailable.",
  completed: "Workflow completed.",
  failed: "The workflow failed.",
  stillRunning: "The workflow is still running.",
};

const responseMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : fallback;
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });

export const invokeCustomAppWorkflow = async (input: {
  endpoint: string;
  body?: Record<string, unknown>;
  signal: AbortSignal;
  onRunning?: () => void;
  onCommittedChanges?: () => void | Promise<void>;
  messages?: CustomAppWorkflowMessages;
  operation?: CustomAppWorkflowOperation;
  onConfirmExport?: (preview: { runId: string; receiptId: string }, signal: AbortSignal) => Promise<boolean | undefined>;
}): Promise<CustomAppWorkflowOutcome> => {
  const messages = input.messages ?? defaultMessages;
  const operation = input.operation ?? { operationId: crypto.randomUUID() };
  if (!operation.statusUrl) {
    const response = await fetch(input.endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...input.body, operationId: operation.operationId }),
      signal: input.signal,
    });
    if (!response.ok) {
      const message = await responseMessage(response, messages.startFailed);
      if ([400, 401, 403, 404, 422].includes(response.status)) throw new CustomAppWorkflowStartRejected(message);
      throw new Error(message);
    }
    const started = (await response.json()) as { statusUrl?: unknown };
    if (typeof started.statusUrl !== "string") throw new Error(messages.statusUnavailable);
    operation.statusUrl = started.statusUrl;
  }
  input.onRunning?.();

  const confirmedReceipts = new Set<string>();
  let live = false;
  let committedChanges = 0;
  const deadline = Date.now() + 300_000;
  for (let attempt = 0; attempt < 150 && Date.now() < deadline; attempt += 1) {
    if (attempt > 0 && !live) await delay(Math.min(400 + attempt * 100, 2_000), input.signal);
    input.signal.throwIfAborted();
    let status: {
      status?: unknown;
      message?: unknown;
      documentConfirmation?: unknown;
      live?: unknown;
      committedChanges?: unknown;
      navigateTo?: unknown;
    };
    try {
      const statusResponse = await fetch(operation.statusUrl, {
        headers: { Accept: "application/json", ...(live ? { "X-Workflow-Changes": String(committedChanges) } : {}) },
        signal: input.signal,
      });
      if (!statusResponse.ok) return { kind: "running", message: messages.statusUnavailable };
      status = await statusResponse.json();
    } catch (error) {
      if (input.signal.aborted) throw error;
      return { kind: "running", message: messages.statusUnavailable };
    }
    live = status.live === true;
    if (typeof status.committedChanges === "number" && status.committedChanges > committedChanges) {
      committedChanges = status.committedChanges;
      if (status.status !== "succeeded") await input.onCommittedChanges?.();
    }
    if (status.status === "succeeded") {
      return {
        kind: "success",
        message: typeof status.message === "string" ? status.message : messages.completed,
        ...(typeof status.navigateTo === "string" && /^\/apps\/[A-Za-z0-9]{6}\//.test(status.navigateTo)
          ? { navigateTo: status.navigateTo }
          : {}),
      };
    }
    if (status.status === "failed") {
      return { kind: "error", message: typeof status.message === "string" ? status.message : messages.failed };
    }
    if (status.documentConfirmation !== undefined) {
      // An already-reviewed receipt can remain visible until the worker resumes.
      live = false;
      const pending = WorkflowPendingDocumentConfirmationSchema.safeParse(status.documentConfirmation);
      if (!pending.success) return { kind: "running", message: messages.statusUnavailable };
      if (!confirmedReceipts.has(pending.data.receiptId)) {
        input.signal.throwIfAborted();
        const confirmed = await input.onConfirmExport?.(pending.data, input.signal);
        input.signal.throwIfAborted();
        if (!confirmed) return { kind: "running", message: messages.awaitingExport ?? messages.stillRunning };
        confirmedReceipts.add(pending.data.receiptId);
      }
    }
  }
  return { kind: "running", message: messages.stillRunning };
};
