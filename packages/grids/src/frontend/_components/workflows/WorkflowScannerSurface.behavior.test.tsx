import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import { fakeLiveConnection } from "../live-test-utils";

const domTest = isServer ? test.skip : test;
const subscriptions = fakeLiveConnection();

const run = (status: "running" | "succeeded") => ({
  id: "RUN001",
  workflowId: "WORK01",
  launcherId: "LAUN01",
  baseId: "BASE01",
  workflowRevision: 1,
  mode: "execute" as const,
  channel: "scanner" as const,
  actorUserId: null,
  serviceAccountId: null,
  inputs: {},
  status,
  result: null,
  error: null,
  resultMessage: status === "succeeded" ? "Checked in" : null,
  createdAt: "2026-09-12T10:00:00Z",
  startedAt: "2026-09-12T10:00:00Z",
  finishedAt: status === "succeeded" ? "2026-09-12T10:00:01Z" : null,
});

const step = {
  runId: "RUN001",
  key: "checkIn",
  sourcePath: ["checkIn"],
  iterationPath: [],
  kind: "action",
  action: "updateRecord",
  status: "completed",
  outcome: null,
  executionGeneration: 1,
  startedAt: "2026-09-12T10:00:00Z",
  finishedAt: "2026-09-12T10:00:01Z",
};

/** The update a finished run sends: a run transition names no step. */
const finished = { v: 1, baseId: "BASE01", workflowId: "WORK01", run: run("succeeded"), steps: [], scope: { kind: "workflow" } };

const receipt = {
  runId: "RUN001",
  workflowId: "WORK01",
  revision: "1",
  mode: "execute",
  channel: "scanner",
  created: true,
  status: "queued",
};

/** Renders a scanner that scans `TICKET-1` once it is set up; the scan's request stays open until `accept`. */
const renderScanner = async (dom: ReturnType<typeof createDomTestHarness>) => {
  let accept: (() => void) | undefined;
  const calls: string[] = [];
  const { render } = await import("solid-js/web");
  const { default: WorkflowScannerSurface } = await import("./WorkflowScannerSurface");
  const dispose = render(
    () => (
      <WorkflowScannerSurface
        mode="dialog"
        state={{
          baseId: "BASE01",
          launcherId: "LAUN01",
          expectedRevision: 1,
          workflowId: "WORK01",
          workflowName: "Check-in",
          workflowDescription: null,
          initialCode: "TICKET-1",
          returnHref: null,
          inputContract: { workflow: { id: "WORK01", name: "Check-in", plan: { inputs: [], bindings: {} } }, tables: [], inputSources: {} },
          liveCursor: "s6t.page.1",
        }}
        transport={{
          invokeLauncher: () => {
            calls.push("invoke");
            return new Promise((resolve) => {
              accept = () => resolve(Response.json(receipt, { status: 202 }));
            });
          },
          getRun: async () => {
            calls.push("run");
            return Response.json(run("succeeded"));
          },
          getSteps: async () => {
            calls.push("steps");
            return Response.json({ items: [step], truncated: false });
          },
        }}
      />
    ),
    dom.root,
  );
  return { dispose, calls, accept: () => accept?.() };
};

/** Opens the scan's details and returns their text. */
const details = async (dom: ReturnType<typeof createDomTestHarness>) => {
  const scan = Array.from(dom.root.querySelectorAll("button")).find((button) => button.textContent?.includes("TICKET-1"));
  scan?.click();
  await Bun.sleep(30);
  const text = dom.document.body.textContent ?? "";
  const { dialogCore } = await import("@k2b/ui");
  dialogCore.close();
  return text;
};

domTest("a scan that finishes keeps its steps: the finished run is read again", async () => {
  const dom = createDomTestHarness();
  const scanner = await renderScanner(dom);
  try {
    await Bun.sleep(30);
    const runs = subscriptions.find((subscription) => subscription.channel === "runs" && !subscription.closed)!;
    expect(runs).toMatchObject({ scope: { workflow: "WORK01" }, cursor: "s6t.page.1" });
    scanner.accept();
    await Bun.sleep(30);
    // The update counts as applied once the run and its steps are shown.
    await runs.deliver([finished]);
    expect(scanner.calls).toEqual(["invoke", "run", "steps"]);
    const text = await details(dom);
    expect(text).toContain("checkIn");
    expect(text).not.toContain("No step data loaded yet.");
  } finally {
    scanner.dispose();
    dom.cleanup();
  }
});

domTest("a scan that finishes before its request returns reads the finished run", async () => {
  const dom = createDomTestHarness();
  const scanner = await renderScanner(dom);
  try {
    await Bun.sleep(30);
    const runs = subscriptions.find((subscription) => subscription.channel === "runs" && !subscription.closed)!;
    // The update arrives before the scan knows its run, so it waits for the receipt.
    await runs.deliver([finished]);
    expect(scanner.calls).toEqual(["invoke"]);
    scanner.accept();
    await Bun.sleep(30);
    expect(scanner.calls).toEqual(["invoke", "run", "steps"]);
    const text = await details(dom);
    expect(text).toContain("Checked in");
    expect(text).toContain("checkIn");
  } finally {
    scanner.dispose();
    dom.cleanup();
  }
});

domTest("a return to the tab reads the active scans, whose update may never have been written", async () => {
  const dom = createDomTestHarness();
  const scanner = await renderScanner(dom);
  try {
    await Bun.sleep(30);
    scanner.accept();
    await Bun.sleep(30);
    expect(scanner.calls).toEqual(["invoke"]);
    dom.document.dispatchEvent(new Event("visibilitychange"));
    await Bun.sleep(30);
    expect(scanner.calls).toEqual(["invoke", "run", "steps"]);
    expect(await details(dom)).toContain("checkIn");
  } finally {
    scanner.dispose();
    dom.cleanup();
  }
});
