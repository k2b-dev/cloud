import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { PublicWorkspaceWorkflowRunDetail } from "./workspace/workspace-public-state-model";
import "./ssr-test-plugin";

const { default: GroupDetailPanel } = await import("./table/GroupDetailPanel");
const { WorkflowRunDetailPanel } = await import("./workflows/WorkflowRunDetailPanel");
const { WorkflowRunDocumentsSection } = await import("./workflows/WorkflowRunDetailSections");

const detail: PublicWorkspaceWorkflowRunDetail = {
  run: {
    id: "run001",
    workflowId: "wf001",
    launcherId: null,
    baseId: "base01",
    workflowRevision: 1,
    mode: "execute",
    channel: "api",
    actorUserId: null,
    serviceAccountId: null,
    inputs: { note: "Equipment request" },
    status: "running",
    result: null,
    error: null,
    resultMessage: null,
    createdAt: "2026-09-08T10:00:00Z",
    startedAt: "2026-09-08T10:00:00Z",
    finishedAt: null,
  },
  inputLabels: {},
  provenance: { workflowName: "Loans", actorLabel: "Valentin", serviceAccountLabel: null, launcherName: null },
  steps: [],
  stepsTruncated: false,
  documents: { items: [], total: 0, hasMore: false, nextOffset: null },
};

function renderRun(initialDetail: PublicWorkspaceWorkflowRunDetail | null, level: "read" | "write" = "read") {
  return renderToString(() =>
    createComponent(WorkflowRunDetailPanel, {
      runId: "run001",
      initialDetail,
      workflows: [],
      workflowLevels: { wf001: level },
      tables: [],
      onRunUpdated: () => {},
      onSelectRun: () => {},
      onClose: () => {},
    }),
  );
}

function expectSharedPanel(html: string, key: string) {
  expect(html.match(/class="k2b-detail-panel__body"/g)).toHaveLength(1);
  expect(html).toContain("k2b-detail-panel__header");
  expect(html).toContain(`data-scroll-preserve="${key}"`);
  expect(html).not.toContain('class="detail-');
}

describe("Grids group and workflow inspectors", () => {
  test("renders group aggregates and search inside the shared scroll body", () => {
    const html = renderToString(() =>
      createComponent(GroupDetailPanel, {
        tableId: "table1",
        fields: [],
        query: {},
        groupBy: [],
        aggregations: [],
        bucket: { keys: [], values: { "*__count": 42 } },
        relationLabels: {},
        onClose: () => {},
        onOpenRecord: () => {},
      }),
    );
    expectSharedPanel(html, "grids-group-detail-table1-[]");
    expect(html).toContain("k2b-detail-panel__summary");
    expect(html).toContain("42");
    expect(html).toContain("ti ti-search");
    expect(html).toContain('type="button"');
  });

  test("keeps workflow facts, inputs, status announcements and read-only controls", () => {
    const html = renderRun(detail);
    expectSharedPanel(html, "grids-workflow-run-detail-run001");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("k2b-detail-panel__summary");
    expect(html).toContain("Valentin");
    expect(html).toContain('title="note"');
    expect(html).toContain("Equipment request");
    expect(html).toContain("ti ti-refresh");
    expect(html).toContain("ti ti-x");
    expect(html).not.toContain("ti ti-repeat");
    expect(html).not.toContain("ti ti-player-stop");
  });

  test("keeps rerun and cancellation permission- and lifecycle-dependent", () => {
    const running = renderRun(detail, "write");
    expect(running).toContain("ti ti-repeat");
    expect(running).toContain("ti ti-player-stop");
    const completed = renderRun({ ...detail, run: { ...detail.run, status: "succeeded" } }, "write");
    expect(completed).toContain("ti ti-repeat");
    expect(completed).not.toContain("ti ti-player-stop");
  });

  test("keeps the loading state in the same body without exposing run actions", () => {
    const html = renderRun(null, "write");
    expectSharedPanel(html, "grids-workflow-run-detail-run001");
    expect(html).not.toContain("k2b-detail-panel__summary");
    expect(html).not.toContain("ti ti-repeat");
    expect(html).not.toContain("ti ti-player-stop");
  });

  test("keeps document download and pagination controls with loading and error feedback", () => {
    const html = renderToString(() =>
      createComponent(WorkflowRunDocumentsSection, {
        documents: { items: [], total: 101, hasMore: true, nextOffset: 100 },
        downloadingDocumentId: null,
        downloadingAll: true,
        loadingMore: true,
        loadMoreError: "Retry this page",
        onDownload: () => {},
        onDownloadAll: () => {},
        onLoadMore: () => {},
      }),
    );
    expect(html).toContain("k2b-detail-panel__section-actions");
    expect(html.match(/ disabled/g)).toHaveLength(2);
    expect(html).toContain("Retry this page");
    expect(html).toContain("Load more");
  });
});
