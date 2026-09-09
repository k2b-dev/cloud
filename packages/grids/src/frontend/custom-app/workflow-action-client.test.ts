import { afterEach, describe, expect, mock, test } from "bun:test";
import { type CustomAppWorkflowOperation, invokeCustomAppWorkflow } from "./workflow-action-client";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

describe("Grids App workflow action client", () => {
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
