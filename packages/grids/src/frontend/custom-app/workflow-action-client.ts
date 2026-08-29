export type CustomAppWorkflowOutcome = {
  kind: "running" | "success" | "error";
  message: string;
};

export type CustomAppWorkflowMessages = {
  startFailed: string;
  statusUnavailable: string;
  completed: string;
  failed: string;
  stillRunning: string;
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
    const timeout = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export const invokeCustomAppWorkflow = async (input: {
  endpoint: string;
  body?: Record<string, unknown>;
  signal: AbortSignal;
  onRunning?: () => void;
  messages?: CustomAppWorkflowMessages;
}): Promise<CustomAppWorkflowOutcome> => {
  const messages = input.messages ?? defaultMessages;
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: crypto.randomUUID(), ...input.body }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(await responseMessage(response, messages.startFailed));
  const started = (await response.json()) as { statusUrl?: unknown };
  if (typeof started.statusUrl !== "string") throw new Error(messages.statusUnavailable);
  input.onRunning?.();

  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(Math.min(400 + attempt * 100, 2_000), input.signal);
    const statusResponse = await fetch(started.statusUrl, { headers: { Accept: "application/json" }, signal: input.signal });
    if (!statusResponse.ok) throw new Error(await responseMessage(statusResponse, messages.statusUnavailable));
    const status = (await statusResponse.json()) as { status?: unknown; message?: unknown };
    if (status.status === "succeeded") {
      return { kind: "success", message: typeof status.message === "string" ? status.message : messages.completed };
    }
    if (status.status === "failed") {
      return { kind: "error", message: typeof status.message === "string" ? status.message : messages.failed };
    }
  }
  return { kind: "running", message: messages.stillRunning };
};
