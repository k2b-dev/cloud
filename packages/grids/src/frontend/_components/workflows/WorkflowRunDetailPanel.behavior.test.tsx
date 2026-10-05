import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { fakeLiveConnection } from "../live-test-utils";
import type { PublicWorkspaceWorkflowRunDetail } from "../workspace/workspace-public-state-model";

const domTest = isServer ? test.skip : test;
const subscriptions = fakeLiveConnection();

domTest("a waiting update during a detail refresh queues the authorized export-review reload", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const initial: PublicWorkspaceWorkflowRunDetail = {
    run: {
      id: "RUN001",
      workflowId: "WORK01",
      launcherId: null,
      baseId: "BASE01",
      workflowRevision: 1,
      mode: "execute",
      channel: "api",
      actorUserId: null,
      serviceAccountId: null,
      inputs: {},
      status: "running",
      result: null,
      error: null,
      resultMessage: null,
      createdAt: "2026-09-12T10:00:00Z",
      startedAt: "2026-09-12T10:00:00Z",
      finishedAt: null,
    },
    inputLabels: {},
    provenance: { workflowName: "Export", actorLabel: null, serviceAccountLabel: null, launcherName: null },
    steps: [],
    stepsTruncated: false,
    documents: { items: [], total: 0, hasMore: false, nextOffset: null },
  };
  const waiting: PublicWorkspaceWorkflowRunDetail = {
    ...initial,
    run: { ...initial.run, status: "waiting" },
    steps: [
      {
        runId: "RUN001",
        key: "export",
        sourcePath: ["steps", 0],
        iterationPath: [],
        kind: "action",
        action: "generateDocument",
        status: "waiting",
        outcome: null,
        documentConfirmation: { receiptId: "DOC001", sha256: "a".repeat(64) },
        executionGeneration: 1,
        startedAt: "2026-09-12T10:00:00Z",
        finishedAt: null,
      },
    ],
  };
  let finishFirst: ((response: Response) => void) | undefined;
  let reads = 0;
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input));
      reads++;
      return reads === 1
        ? new Promise<Response>((resolve) => {
            finishFirst = resolve;
          })
        : Response.json(waiting);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { render } = await import("solid-js/web");
  const { WorkflowRunDetailPanel } = await import("./WorkflowRunDetailPanel");
  const dispose = render(
    () => (
      <WorkflowRunDetailPanel
        runId="RUN001"
        initialDetail={initial}
        workflows={[]}
        workflowLevels={{}}
        tables={[]}
        liveCursor="s6t.page.4"
        onRunUpdated={() => {}}
        onSelectRun={() => {}}
        onClose={() => {}}
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(30);
    // The panel follows the run's workflow from the page's cursor and reads nothing until something changes.
    const [runs] = subscriptions;
    expect(runs).toMatchObject({ url: "/api/grids/live", channel: "runs", scope: { workflow: "WORK01" }, cursor: "s6t.page.4" });
    expect(reads).toBe(0);
    void runs!.resync();
    await Bun.sleep(30);
    expect(reads).toBe(1);
    const { documentConfirmation: _confirmation, ...stepSummary } = waiting.steps[0]!;
    await runs!.deliver([
      { v: 1, baseId: "BASE01", workflowId: "WORK01", run: waiting.run, steps: [stepSummary], scope: { kind: "workflow" } },
    ]);
    expect(reads).toBe(1);
    finishFirst!(Response.json(initial));
    await Bun.sleep(80);
    expect(reads).toBe(2);
    expect(urls.every((url) => url.includes("workflow-run-detail") && url.includes("runId=RUN001"))).toBe(true);
    expect(Array.from(dom.root.querySelectorAll("button")).some((button) => button.textContent?.includes("Review export"))).toBe(true);
  } finally {
    dispose();
    expect(subscriptions[0]?.closed).toBe(true);
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
