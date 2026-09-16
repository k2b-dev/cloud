import { expect, test } from "bun:test";
import type { GridsWorkflowRunEvent } from "../lib/workflow-run-events";
import { waitForCustomAppWorkflowChange } from "./custom-app-workflow-progress";

const event = (runId: string, status: GridsWorkflowRunEvent["run"]["status"]) => ({
  cursor: "cursor",
  sequence: 1,
  eventId: "event",
  tenantId: "base:workflow",
  publishedAt: new Date(),
  data: {
    v: 1,
    baseId: "base",
    workflowId: "workflow",
    scope: { kind: "workflow" },
    steps: [],
    run: {
      id: runId,
      workflowId: "workflow",
      launcherId: "launcher",
      baseId: "base",
      workflowRevision: 1,
      mode: "execute",
      channel: "customApp",
      status,
      error: null,
      resultMessage: null,
      createdAt: "2026-09-16T00:00:00Z",
      startedAt: null,
      finishedAt: null,
    },
  } satisfies GridsWorkflowRunEvent,
});
const input = { baseId: "base", workflowId: "workflow", runId: "mine", after: "previous", signal: new AbortController().signal };

test("status waiting ignores other runs and closes the event subscription after its own transition", async () => {
  let closed = false;
  let delivered = 0;
  expect(
    await waitForCustomAppWorkflowChange(input, async function* () {
      try {
        delivered++;
        yield event("other", "succeeded");
        delivered++;
        yield event("mine", "running");
        delivered++;
        yield event("mine", "succeeded");
        delivered++;
        yield event("mine", "succeeded");
      } finally {
        closed = true;
      }
    }),
  ).toBe(true);
  expect(delivered).toBe(3);
  expect(closed).toBe(true);
});

test("broker failure requests polling fallback", async () => {
  expect(
    await waitForCustomAppWorkflowChange(input, () => {
      throw new Error("broker unavailable");
    }),
  ).toBe(false);
});

test("request cancellation ends the subscription", async () => {
  const controller = new AbortController();
  let closed = false;
  const waiting = waitForCustomAppWorkflowChange({ ...input, signal: controller.signal }, async function* (options) {
    try {
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    } finally {
      closed = true;
    }
  });
  controller.abort();
  await waiting;
  expect(closed).toBe(true);
});
