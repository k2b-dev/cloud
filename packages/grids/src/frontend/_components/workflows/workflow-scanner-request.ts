import type { WorkflowJsonValue } from "@k2b/cloud/workflows";

type WorkflowScannerRequest = {
  operationId: string;
  expectedRevision: number;
  code: string;
  inputs?: Record<string, WorkflowJsonValue>;
};

type WorkflowScannerRequestTarget = {
  launcherId: string;
};

type LauncherRequestInput = {
  param: { launcherId: string };
  json: {
    operationId: string;
    mode: "execute";
    expectedRevision: number;
    inputs: Record<string, WorkflowJsonValue>;
    scannedText: string;
  };
};

export type WorkflowScannerTransport = {
  invokeLauncher: (input: LauncherRequestInput) => Promise<Response>;
};

export const invokeWorkflowScannerRequest = (
  transport: WorkflowScannerTransport,
  target: WorkflowScannerRequestTarget,
  request: WorkflowScannerRequest,
): Promise<Response> => {
  return transport.invokeLauncher({
    param: { launcherId: target.launcherId },
    json: {
      operationId: request.operationId,
      mode: "execute",
      expectedRevision: request.expectedRevision,
      inputs: request.inputs ?? {},
      scannedText: request.code,
    },
  });
};

export const workflowScannerResponseKind = (response: Pick<Response, "ok" | "status">): "accepted" | "revision-conflict" | "failed" =>
  response.ok ? "accepted" : response.status === 409 ? "revision-conflict" : "failed";
