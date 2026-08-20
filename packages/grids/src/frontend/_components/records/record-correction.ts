import { z } from "zod";
import { PublicGridsWorkflowRunSchema, PublicWorkflowInvocationReceiptSchema } from "../../../api/workflow-public-contracts";
import { errorMessage } from "../utils/api-helpers";

const CorrectionDraftResultSchema = z.object({ kind: z.literal("record"), recordId: z.string(), tableId: z.string() });

type Request = (input: string, init: RequestInit) => Promise<Response>;

export class CorrectionDraftInvocationError extends Error {
  constructor(
    message: string,
    readonly retrySameOperation: boolean,
  ) {
    super(message);
  }
}

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });

export const createCorrectionDraft = async (params: {
  launcherId: string;
  expectedRevision: number;
  recordId: string;
  operationId: string;
  signal: AbortSignal;
  request?: Request;
  pollDelayMs?: number;
  timeoutMs?: number;
}): Promise<{ recordId: string; tableId: string }> => {
  const request = params.request ?? fetch;
  let response: Response;
  try {
    response = await request(`/api/grids/workflows/launchers/${encodeURIComponent(params.launcherId)}/invoke/record`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: params.operationId,
        mode: "execute",
        expectedRevision: params.expectedRevision,
        recordId: params.recordId,
        inputs: {},
      }),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal.aborted) throw error;
    throw new CorrectionDraftInvocationError(error instanceof Error ? error.message : "Could not start correction workflow", true);
  }
  if (!response.ok) {
    throw new CorrectionDraftInvocationError(await errorMessage(response, "Could not create correction Draft"), response.status >= 500);
  }
  let receipt: z.infer<typeof PublicWorkflowInvocationReceiptSchema>;
  try {
    receipt = PublicWorkflowInvocationReceiptSchema.parse(await response.json());
  } catch (error) {
    throw new CorrectionDraftInvocationError(error instanceof Error ? error.message : "Invalid correction workflow response", true);
  }
  const deadline = Date.now() + (params.timeoutMs ?? 30_000);
  while (true) {
    let runResponse: Response;
    try {
      runResponse = await request(`/api/grids/workflows/runs/${encodeURIComponent(receipt.runId)}`, {
        method: "GET",
        credentials: "same-origin",
        signal: params.signal,
      });
    } catch (error) {
      if (params.signal.aborted) throw error;
      throw new CorrectionDraftInvocationError(error instanceof Error ? error.message : "Could not refresh correction workflow", true);
    }
    if (!runResponse.ok) {
      throw new CorrectionDraftInvocationError(await errorMessage(runResponse, "Could not refresh correction workflow"), true);
    }
    let run: z.infer<typeof PublicGridsWorkflowRunSchema>;
    try {
      run = PublicGridsWorkflowRunSchema.parse(await runResponse.json());
    } catch (error) {
      throw new CorrectionDraftInvocationError(error instanceof Error ? error.message : "Invalid correction workflow response", true);
    }
    if (run.status === "succeeded") {
      try {
        const result = CorrectionDraftResultSchema.parse(run.result);
        return { recordId: result.recordId, tableId: result.tableId };
      } catch (error) {
        throw new CorrectionDraftInvocationError(error instanceof Error ? error.message : "Invalid correction workflow result", false);
      }
    }
    if (run.status === "failed" || run.status === "canceled" || run.status === "needs_attention") {
      throw new CorrectionDraftInvocationError(run.error?.message ?? "The correction workflow did not complete.", false);
    }
    if (Date.now() >= deadline) {
      throw new CorrectionDraftInvocationError(
        `The correction workflow is still running. Open run ${receipt.runId} to follow progress.`,
        true,
      );
    }
    await delay(params.pollDelayMs ?? 750, params.signal);
  }
};
