import { describe, expect, mock, test } from "bun:test";
import { CorrectionDraftInvocationError, createCorrectionDraft } from "./record-correction";

const json = (value: unknown, status = 200) => Response.json(value, { status });

const receipt = {
  runId: "Run001",
  workflowId: "Work01",
  revision: "3",
  mode: "execute",
  channel: "record",
  created: true,
  status: "queued",
} as const;

const run = (status: "queued" | "succeeded" | "failed", result: unknown = null) => ({
  id: "Run001",
  workflowId: "Work01",
  launcherId: "Lnch01",
  baseId: "Base01",
  workflowRevision: 3,
  mode: "execute",
  channel: "record",
  actorUserId: "11111111-1111-4111-8111-111111111111",
  serviceAccountId: null,
  inputs: { original: "Rec001" },
  status,
  result,
  error: status === "failed" ? { code: "CONFLICT", message: "Original is not final", retryable: false } : null,
  resultMessage: null,
  createdAt: "2026-08-20T12:00:00.000Z",
  startedAt: "2026-08-20T12:00:00.000Z",
  finishedAt: status === "queued" ? null : "2026-08-20T12:00:01.000Z",
});

describe("correction Draft Record action", () => {
  test("submits only the open public Record and returns the completed Draft", async () => {
    const responses = [
      json(receipt),
      json(run("queued")),
      json(run("succeeded", { kind: "record", tableId: "Tab001", recordId: "New001" })),
    ];
    const request = mock(async (_input: string, _init: RequestInit) => responses.shift() ?? json({ message: "unexpected" }, 500));

    const result = await createCorrectionDraft({
      launcherId: "Lnch01",
      expectedRevision: 3,
      recordId: "Rec001",
      operationId: "correction-1",
      signal: new AbortController().signal,
      request,
      pollDelayMs: 0,
    });

    expect(result).toEqual({ tableId: "Tab001", recordId: "New001" });
    expect(request.mock.calls[0]?.[0]).toBe("/api/grids/workflows/launchers/Lnch01/invoke/record");
    expect(JSON.parse(String(request.mock.calls[0]?.[1].body))).toMatchObject({
      mode: "execute",
      expectedRevision: 3,
      recordId: "Rec001",
      operationId: "correction-1",
      inputs: {},
    });
    expect(request.mock.calls[1]?.[0]).toBe("/api/grids/workflows/runs/Run001");
  });

  test("reports the workflow's terminal error without opening a Draft", async () => {
    const responses = [json(receipt), json(run("failed"))];
    const request = mock(async (_input: string, _init: RequestInit) => responses.shift() ?? json({ message: "unexpected" }, 500));

    try {
      await createCorrectionDraft({
        launcherId: "Lnch01",
        expectedRevision: 3,
        recordId: "Rec001",
        operationId: "correction-1",
        signal: new AbortController().signal,
        request,
      });
      throw new Error("Expected the workflow to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CorrectionDraftInvocationError);
      expect((error as CorrectionDraftInvocationError).message).toBe("Original is not final");
      expect((error as CorrectionDraftInvocationError).retrySameOperation).toBe(false);
    }
  });

  test("keeps the operation identity after an ambiguous transport failure", async () => {
    const request = mock(async () => {
      throw new Error("Connection lost");
    });

    try {
      await createCorrectionDraft({
        launcherId: "Lnch01",
        expectedRevision: 3,
        recordId: "Rec001",
        operationId: "correction-1",
        signal: new AbortController().signal,
        request,
      });
      throw new Error("Expected the request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CorrectionDraftInvocationError);
      expect((error as CorrectionDraftInvocationError).retrySameOperation).toBe(true);
    }
  });

  test("keeps a slow run recoverable by naming its public run ID", async () => {
    const responses = [json(receipt), json(run("queued"))];
    const request = mock(async (_input: string, _init: RequestInit) => responses.shift() ?? json({ message: "unexpected" }, 500));

    await expect(
      createCorrectionDraft({
        launcherId: "Lnch01",
        expectedRevision: 3,
        recordId: "Rec001",
        operationId: "correction-1",
        signal: new AbortController().signal,
        request,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("Open run Run001");
  });

  test("localizes fallback errors with BCP-47 language fallback", async () => {
    const responses = [json(receipt), json(run("queued"))];
    const request = mock(async (_input: string, _init: RequestInit) => responses.shift() ?? json({ message: "unexpected" }, 500));

    await expect(
      createCorrectionDraft({
        launcherId: "Lnch01",
        expectedRevision: 3,
        recordId: "Rec001",
        operationId: "correction-1",
        signal: new AbortController().signal,
        request,
        timeoutMs: 0,
        locale: "de-CH",
      }),
    ).rejects.toThrow("Öffne Lauf Run001");
  });

  test("uses a new operation after a terminal run returns an invalid result", async () => {
    const responses = [json(receipt), json(run("succeeded", { kind: "record", tableId: "Tab001" }))];
    const request = mock(async (_input: string, _init: RequestInit) => responses.shift() ?? json({ message: "unexpected" }, 500));

    try {
      await createCorrectionDraft({
        launcherId: "Lnch01",
        expectedRevision: 3,
        recordId: "Rec001",
        operationId: "correction-1",
        signal: new AbortController().signal,
        request,
      });
      throw new Error("Expected the workflow result to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(CorrectionDraftInvocationError);
      expect((error as CorrectionDraftInvocationError).retrySameOperation).toBe(false);
    }
  });
});
