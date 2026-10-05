import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { fakeLiveConnection } from "../live-test-utils";
import type { PublicWorkflowRun, PublicWorkspaceWorkflowRunDetail } from "../workspace/workspace-public-state-model";

const domTest = isServer ? test.skip : test;
const subscriptions = fakeLiveConnection();

const detail = (id: string, status: PublicWorkflowRun["status"]): PublicWorkspaceWorkflowRunDetail => ({
  run: {
    id,
    workflowId: "WORK01",
    launcherId: null,
    baseId: "BASE01",
    workflowRevision: 1,
    mode: "execute",
    channel: "api",
    actorUserId: null,
    serviceAccountId: null,
    inputs: {},
    status,
    result: null,
    error: null,
    resultMessage: null,
    createdAt: "2026-09-12T10:00:00Z",
    startedAt: status === "queued" ? null : "2026-09-12T10:00:00Z",
    finishedAt: null,
  },
  inputLabels: {},
  provenance: { workflowName: "Export", actorLabel: null, serviceAccountLabel: null, launcherName: null },
  steps: [],
  stepsTruncated: false,
  documents: { items: [], total: 0, hasMore: false, nextOffset: null },
});

/** A run update for `run`, as the live channel delivers it. */
const update = (run: PublicWorkflowRun, steps: unknown[] = []) => ({
  v: 1,
  baseId: "BASE01",
  workflowId: "WORK01",
  run,
  steps,
  scope: { kind: "workflow" },
});

/** Answers detail reads in order; a read without a prepared answer stays open until `finish` answers it. */
const detailReads = () => {
  const urls: string[] = [];
  const open: ((response: Response) => void)[] = [];
  const prepared: Response[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(String(input));
      const answer = prepared.shift();
      return answer ?? new Promise<Response>((resolve) => open.push(resolve));
    },
    { preconnect: originalFetch.preconnect },
  );
  return {
    urls,
    prepare: (response: Response) => prepared.push(response),
    finish: (response: Response) => open.shift()?.(response),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const renderPanel = async (
  dom: ReturnType<typeof createDomTestHarness>,
  runId: () => string,
  onRunUpdated = (_run: PublicWorkflowRun) => {},
) => {
  const { render } = await import("solid-js/web");
  const { WorkflowRunDetailPanel } = await import("./WorkflowRunDetailPanel");
  return render(
    () => (
      <WorkflowRunDetailPanel
        runId={runId()}
        initialDetail={detail("RUN001", "running")}
        workflows={[]}
        workflowLevels={{}}
        tables={[]}
        liveCursor="s6t.page.4"
        onRunUpdated={onRunUpdated}
        onSelectRun={() => {}}
        onClose={() => {}}
      />
    ),
    dom.root,
  );
};

domTest("a waiting update during a detail read applies after it and reads the export review", async () => {
  const dom = createDomTestHarness();
  const reads = detailReads();
  const waiting = detail("RUN001", "waiting");
  waiting.steps = [
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
  ];
  const dispose = await renderPanel(dom, () => "RUN001");
  try {
    await Bun.sleep(30);
    // The panel follows the run's workflow from the page's cursor and reads nothing until something changes.
    const [runs] = subscriptions;
    expect(runs).toMatchObject({ url: "/api/grids/live", channel: "runs", scope: { workflow: "WORK01" }, cursor: "s6t.page.4" });
    expect(reads.urls).toHaveLength(0);
    const resynced = runs!.resync();
    await Bun.sleep(30);
    expect(reads.urls).toHaveLength(1);
    const { documentConfirmation: _confirmation, ...stepSummary } = waiting.steps[0]!;
    const delivered = runs!.deliver([update(waiting.run, [stepSummary])]);
    await Bun.sleep(30);
    // The update waits for the read in flight, which may predate it.
    expect(reads.urls).toHaveLength(1);
    reads.prepare(Response.json(waiting));
    reads.finish(Response.json(detail("RUN001", "running")));
    await resynced;
    // A parked run is read again; the update counts as applied once that read is shown.
    await delivered;
    expect(reads.urls).toHaveLength(2);
    expect(reads.urls.every((url) => url.includes("workflow-run-detail") && url.includes("runId=RUN001"))).toBe(true);
    expect(Array.from(dom.root.querySelectorAll("button")).some((button) => button.textContent?.includes("Review export"))).toBe(true);
  } finally {
    dispose();
    expect(subscriptions.at(-1)?.closed).toBe(true);
    reads.restore();
    dom.cleanup();
  }
});

domTest("a resync settles once its read is shown, an older read never overwrites a newer update, and a failed read rejects", async () => {
  const dom = createDomTestHarness();
  const reads = detailReads();
  const statuses: string[] = [];
  const dispose = await renderPanel(
    dom,
    () => "RUN001",
    (run) => statuses.push(run.status),
  );
  try {
    await Bun.sleep(30);
    const runs = subscriptions.at(-1)!;
    let settled = false;
    const resynced = runs.resync().then(() => {
      settled = true;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false);
    // The next step starts while the read runs; the read answers with what it saw before.
    const delivered = runs.deliver([update({ ...detail("RUN001", "running").run, resultMessage: "Step 2" })]);
    reads.finish(Response.json(detail("RUN001", "queued")));
    await resynced;
    await delivered;
    expect(statuses.at(-1)).toBe("running");
    expect(reads.urls).toHaveLength(1);

    reads.prepare(Response.json({ message: "Database unavailable" }, { status: 503 }));
    await expect(runs.resync()).rejects.toThrow("Database unavailable");
  } finally {
    dispose();
    reads.restore();
    dom.cleanup();
  }
});

domTest("an update for a run that is no longer selected does not replace the selected run's read", async () => {
  const dom = createDomTestHarness();
  const reads = detailReads();
  const [runId, setRunId] = createSignal("RUN001");
  const dispose = await renderPanel(dom, runId);
  try {
    await Bun.sleep(30);
    const runs = subscriptions.at(-1)!;
    const resynced = runs.resync();
    await Bun.sleep(30);
    // A finished update waits for that read, and the person opens another run meanwhile.
    const delivered = runs.deliver([update({ ...detail("RUN001", "succeeded").run, finishedAt: "2026-09-12T10:01:00Z" })]);
    reads.prepare(Response.json(detail("RUN002", "running")));
    // Answered only if the update read its run, which is no longer shown.
    reads.prepare(Response.json({ message: "Run not found" }, { status: 404 }));
    setRunId("RUN002");
    await Bun.sleep(30);
    reads.finish(Response.json(detail("RUN001", "running")));
    await resynced;
    await delivered;
    await Bun.sleep(30);
    expect(reads.urls.map((url) => new URL(url, "http://localhost").searchParams.get("runId"))).toEqual(["RUN001", "RUN002"]);
    expect(dom.root.textContent).not.toContain("Run not found");
  } finally {
    dispose();
    reads.restore();
    dom.cleanup();
  }
});

domTest("a return to the tab reads a running run, whose update may never have been written", async () => {
  const dom = createDomTestHarness();
  const reads = detailReads();
  const dispose = await renderPanel(dom, () => "RUN001");
  try {
    await Bun.sleep(30);
    expect(reads.urls).toHaveLength(0);
    reads.prepare(Response.json(detail("RUN001", "running")));
    dom.document.dispatchEvent(new Event("visibilitychange"));
    await Bun.sleep(30);
    expect(reads.urls).toHaveLength(1);
  } finally {
    dispose();
    reads.restore();
    dom.cleanup();
  }
});
