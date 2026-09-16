import { afterEach, describe, expect, mock, test } from "bun:test";
import { type CustomAppWorkflowOperation, invokeCustomAppWorkflow } from "./workflow-action-client";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

describe("Grids App workflow action client", () => {
  test("closing export review preserves the operation; retry reviews the same receipt and never invokes twice", async () => {
    const operation = { operationId: crypto.randomUUID() };
    let starts = 0;
    let polls = 0;
    const pending = { runId: "RUN123", receiptId: "DOC123", sha256: "a".repeat(64) };
    globalThis.fetch = (async (input) => {
      if (String(input) === "/invoke") {
        starts++;
        return Response.json({ statusUrl: "/status" });
      }
      polls++;
      return Response.json(polls < 4 ? { status: "running", documentConfirmation: pending } : { status: "succeeded" });
    }) as typeof fetch;
    const review = mock(async () => false);
    const args = { endpoint: "/invoke", operation, signal: new AbortController().signal, onConfirmExport: review };
    expect((await invokeCustomAppWorkflow(args)).kind).toBe("running");
    expect(review).toHaveBeenCalledWith(pending, args.signal);
    review.mockImplementation(async () => true);
    expect((await invokeCustomAppWorkflow(args)).kind).toBe("success");
    expect(starts).toBe(1);
    expect(review).toHaveBeenCalledTimes(2);
    expect(polls).toBe(4);
  });

  test("leaving the app aborts an open review and preserves the same server operation", async () => {
    const operation: CustomAppWorkflowOperation = { operationId: crypto.randomUUID(), statusUrl: "/status" };
    const controller = new AbortController();
    const reason = new Error("App disposed");
    let requests = 0;
    globalThis.fetch = Object.assign(
      async () => {
        requests++;
        return Response.json({
          status: "running",
          documentConfirmation: { runId: "RUN123", receiptId: "DOC123", sha256: "a".repeat(64) },
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    await expect(
      invokeCustomAppWorkflow({
        endpoint: "/invoke",
        operation,
        signal: controller.signal,
        onConfirmExport: async (_, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort(reason);
          return undefined;
        },
      }),
    ).rejects.toBe(reason);
    expect(requests).toBe(1);
    expect(operation.statusUrl).toBe("/status");
  });

  test("malformed confirmation metadata never opens a review or confirms anything", async () => {
    globalThis.fetch = (async (input) =>
      Response.json(
        String(input) === "/invoke"
          ? { statusUrl: "/status" }
          : {
              status: "running",
              documentConfirmation: { runId: "not-a-public-id", receiptId: "DOC123", sha256: "a".repeat(64) },
            },
      )) as typeof fetch;
    const review = mock(async () => true);
    expect(
      (await invokeCustomAppWorkflow({ endpoint: "/invoke", signal: new AbortController().signal, onConfirmExport: review })).kind,
    ).toBe("running");
    expect(review).not.toHaveBeenCalled();
  });

  test("status recovery polls the same run instead of posting a second operation", async () => {
    const operation: CustomAppWorkflowOperation = { operationId: crypto.randomUUID() };
    const requests: string[] = [];
    let unavailable = true;
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      if (String(input) === "/invoke") return Response.json({ statusUrl: "/status" });
      return unavailable ? new Response("Unavailable", { status: 503 }) : Response.json({ status: "succeeded" });
    }) as typeof fetch;
    const args = { endpoint: "/invoke", operation, signal: new AbortController().signal };
    expect(await invokeCustomAppWorkflow(args)).toEqual({ kind: "running", message: "The workflow status is unavailable." });
    unavailable = false;
    expect((await invokeCustomAppWorkflow(args)).kind).toBe("success");
    expect(requests).toEqual(["/invoke", "/status", "/status"]);
  });

  test("a lost start response retries with the same operation identity", async () => {
    const operation: CustomAppWorkflowOperation = { operationId: crypto.randomUUID() };
    const ids: string[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) !== "/invoke") return Response.json({ status: "succeeded" });
      ids.push(JSON.parse(String(init?.body)).operationId);
      if (ids.length === 1) throw new TypeError("Network disconnected");
      return Response.json({ statusUrl: "/status" });
    }) as typeof fetch;
    const args = { endpoint: "/invoke", operation, signal: new AbortController().signal };
    await expect(invokeCustomAppWorkflow(args)).rejects.toThrow("Network disconnected");
    expect((await invokeCustomAppWorkflow(args)).kind).toBe("success");
    expect(ids).toEqual([operation.operationId, operation.operationId]);
  });
  test("follows the scoped status URL until the workflow succeeds", async () => {
    const requests: string[] = [];
    const statuses = [
      { status: "running", message: null },
      { status: "succeeded", message: "Request approved." },
    ];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      return url === "/invoke" ? Response.json({ statusUrl: "/status" }, { status: 202 }) : Response.json(statuses.shift());
    }) as typeof fetch;
    const onRunning = mock(() => undefined);

    const result = await invokeCustomAppWorkflow({ endpoint: "/invoke", signal: new AbortController().signal, onRunning });

    expect(result).toEqual({ kind: "success", message: "Request approved." });
    expect(requests).toEqual(["/invoke", "/status", "/status"]);
    expect(onRunning).toHaveBeenCalledTimes(1);
  });

  test("returns only the sanitized failed outcome", async () => {
    globalThis.fetch = (async (input) =>
      String(input) === "/invoke"
        ? Response.json({ statusUrl: "/status" }, { status: 202 })
        : Response.json({ status: "failed", message: "The request could not be approved." })) as typeof fetch;

    expect(await invokeCustomAppWorkflow({ endpoint: "/invoke", signal: new AbortController().signal })).toEqual({
      kind: "error",
      message: "The request could not be approved.",
    });
  });

  test("rejects missing status scope and an already aborted poll", async () => {
    globalThis.fetch = (async () => Response.json({ runId: crypto.randomUUID() }, { status: 202 })) as unknown as typeof fetch;
    await expect(invokeCustomAppWorkflow({ endpoint: "/invoke", signal: new AbortController().signal })).rejects.toThrow(
      "The workflow status is unavailable.",
    );

    const controller = new AbortController();
    const reason = new Error("closed");
    globalThis.fetch = (async () => {
      controller.abort(reason);
      return Response.json({ statusUrl: "/status" }, { status: 202 });
    }) as unknown as typeof fetch;
    await expect(invokeCustomAppWorkflow({ endpoint: "/invoke", signal: controller.signal })).rejects.toBe(reason);
  });

  test("stops polling after the bounded status window", async () => {
    let statusRequests = 0;
    globalThis.setTimeout = ((handler: TimerHandler) => {
      queueMicrotask(() => {
        if (typeof handler === "function") handler();
      });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.fetch = (async (input) => {
      if (String(input) === "/invoke") return Response.json({ statusUrl: "/status" }, { status: 202 });
      statusRequests += 1;
      return Response.json({ status: "running" });
    }) as typeof fetch;

    expect(await invokeCustomAppWorkflow({ endpoint: "/invoke", signal: new AbortController().signal })).toEqual({
      kind: "running",
      message: "The workflow is still running.",
    });
    expect(statusRequests).toBe(150);
  });
});

test("reads status immediately, waits for live changes, and refreshes committed data before completion", async () => {
  const requests: string[] = [];
  const changes: Array<string | null> = [];
  const progress = mock(async () => {});
  const responses = [
    { status: "running", live: true, committedChanges: 0 },
    { status: "running", live: true, committedChanges: 1 },
    { status: "running", live: true, committedChanges: 1 },
    { status: "succeeded", live: true, committedChanges: 1 },
  ];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      changes.push(new Headers(init?.headers).get("X-Workflow-Changes"));
      return Response.json(responses.shift());
    },
    { preconnect: originalFetch.preconnect },
  );
  const invocation = invokeCustomAppWorkflow({
    endpoint: "/invoke",
    operation: { operationId: "existing", statusUrl: "/status?record=1" },
    signal: new AbortController().signal,
    onCommittedChanges: progress,
  });
  expect(requests).toEqual(["/status?record=1"]);
  expect((await invocation).kind).toBe("success");
  expect(requests).toEqual(Array(4).fill("/status?record=1"));
  expect(changes).toEqual([null, "0", "1", "1"]);
  expect(progress).toHaveBeenCalledTimes(1);
});

test("a reviewed receipt still awaiting resume falls back to paced polling", async () => {
  const pending = { runId: "RUN123", receiptId: "DOC123", sha256: "a".repeat(64) };
  const headers: Headers[] = [];
  const review = mock(async () => true);
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return Response.json(
        headers.length <= 3
          ? { status: "running", live: true, committedChanges: 0, documentConfirmation: pending }
          : { status: "succeeded" },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const result = await invokeCustomAppWorkflow({
    endpoint: "/invoke",
    operation: { operationId: "existing", statusUrl: "/status" },
    signal: new AbortController().signal,
    onConfirmExport: review,
  });
  expect(result.kind).toBe("success");
  expect(review).toHaveBeenCalledTimes(1);
  expect(headers.every((header) => !header.has("X-Workflow-Changes"))).toBe(true);
});
