import { describe, expect, test } from "bun:test";
import type { WorkflowRunSummary } from "@k2b/cloud/workflows/store";
import { buildWorkflowTimelineRows, WORKFLOW_TIMELINE_LANES } from "./timeline";

const WINDOW = { fromMs: 1_000_000, toMs: 1_000_000 + 3_600_000 };

const run = (values: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  id: crypto.randomUUID(),
  appId: "mail",
  scopeId: "mailbox-1",
  workflowId: "67b79ab9-9ae8-418d-a3c3-649f1af3c486",
  workflowName: "Enrich chat",
  revision: 1,
  mode: "execute",
  state: "succeeded",
  attempt: 1,
  eventType: "mail.messageReceived",
  parentRunId: null,
  occurredAt: new Date(WINDOW.fromMs + 60_000),
  createdAt: new Date(WINDOW.fromMs + 60_000),
  startedAt: new Date(WINDOW.fromMs + 60_010),
  finishedAt: new Date(WINDOW.fromMs + 60_032),
  startLagMs: 10,
  durationMs: 22,
  error: null,
  resultMessage: null,
  ...values,
});

describe("buildWorkflowTimelineRows", () => {
  test("keeps short completed runs visible without moving their start", () => {
    const [row] = buildWorkflowTimelineRows([run()], WINDOW);
    const interval = row?.intervals[0];
    expect(interval?.from).toBe(WINDOW.fromMs + 60_010);
    expect(interval?.to).toBeGreaterThan((interval?.from ?? 0) + 22);
    expect(interval?.state).toBe("succeeded");
  });

  test("shows queued age from creation until the end of the window", () => {
    const [row] = buildWorkflowTimelineRows(
      [
        run({
          state: "queued",
          attempt: 0,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          createdAt: new Date(WINDOW.fromMs + 10_000),
        }),
      ],
      WINDOW,
    );
    expect(row?.intervals[0]).toMatchObject({ from: WINDOW.fromMs + 10_000, to: WINDOW.toMs, state: "queued" });
  });

  test("groups by workflow identity and keeps the busiest lanes", () => {
    const runs = Array.from({ length: WORKFLOW_TIMELINE_LANES + 3 }, (_, index) =>
      Array.from({ length: index + 1 }, () =>
        run({
          workflowId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          workflowName: `Workflow ${index}`,
        }),
      ),
    ).flat();
    const rows = buildWorkflowTimelineRows(runs, WINDOW);
    expect(rows).toHaveLength(WORKFLOW_TIMELINE_LANES);
    expect(rows[0]?.label).toBe(`Workflow ${WORKFLOW_TIMELINE_LANES + 2}`);
  });

  test("skips runs outside the selected window", () => {
    expect(buildWorkflowTimelineRows([run({ createdAt: new Date(WINDOW.toMs + 1), startedAt: null })], WINDOW)).toEqual([]);
  });
});
