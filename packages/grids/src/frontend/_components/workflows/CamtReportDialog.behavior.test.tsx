import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { WorkflowFilePreview } from "../../../workflows/file-preview-contracts";

const domTest = isServer ? test.skip : test;
domTest("CAMT preview can retry an unavailable response without offering a stale download", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return calls === 1
        ? Response.json({ message: "Temporarily unavailable" }, { status: 503 })
        : Response.json({
            filename: "empty.xml",
            format: "camt.052.001.08",
            messageId: "empty",
            createdAt: "2026-09-15T12:00:00Z",
            capturedAt: "2026-09-15T12:00:00.000Z",
            pagination: null,
            reports: [],
          } satisfies WorkflowFilePreview);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openCamtReportDialog } = await import("./CamtReportDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openCamtReportDialog("RUN001", {
      kind: "fileSnapshot",
      stepKey: "steps.0",
      sha256: "a".repeat(64),
      rowCount: 0,
      capturedAt: "2026-09-15T12:00:00.000Z",
    });
    await Bun.sleep(80);
    expect(dom.document.body.textContent).toContain("Temporarily unavailable");
    expect(dom.document.querySelector('a[href*="download=original"]')).toBeNull();
    Array.from(dom.document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Try again")!
      .click();
    await Bun.sleep(80);
    expect(calls).toBe(2);
    expect(dom.document.body.textContent).not.toContain("Temporarily unavailable");
    expect(dom.document.body.textContent).toContain("No account reports");
    expect(dom.document.querySelector('a[href*="download=original"]')).not.toBeNull();
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
domTest("CAMT overview discloses partial reports, paginates accounts, and downloads the exact capture", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const preview: WorkflowFilePreview = {
    filename: "bank.xml",
    format: "camt.052.001.08",
    capturedAt: "2026-09-15T12:00:00.000Z",
    messageId: "message-1",
    createdAt: "2026-09-15T12:00:00+02:00",
    pagination: { pageNumber: "1", lastPage: false },
    reports: [
      {
        id: "report-1",
        account: "first-account",
        currency: "EUR",
        period: null,
        pagination: null,
        entryCount: 1,
        statuses: { PDNG: 1 },
        details: { amount: "125.50", direction: "DBIT", reversal: true },
      },
      {
        id: "report-2",
        account: "second-account",
        currency: null,
        period: null,
        pagination: null,
        entryCount: 0,
        statuses: {},
        details: {},
      },
    ],
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return Response.json(preview);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openCamtReportDialog } = await import("./CamtReportDialog");
  const { dialogCore } = await import("@k2b/ui");
  const button = (label: string) => Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim() === label);
  try {
    void openCamtReportDialog("RUN001", {
      kind: "fileSnapshot",
      stepKey: "steps.0",
      sha256: "a".repeat(64),
      rowCount: 2,
      capturedAt: preview.capturedAt,
    });
    await Bun.sleep(80);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/runs/RUN001/files/steps.0?sha256=");
    expect(dom.document.body.textContent).toContain("first-account");
    expect(dom.document.body.textContent).toContain("not the last page");
    expect(dom.document.body.textContent).toContain("does not confirm a payment");
    expect(dom.document.body.textContent).toContain("PDNG: 1");
    const detailBody = dom.document.querySelector(".k2b-detail-panel__section-body");
    expect(detailBody?.hasAttribute("hidden")).toBe(true);
    button("Report details")!.click();
    expect(detailBody?.hasAttribute("hidden")).toBe(false);
    expect(dom.document.body.textContent).toContain("125.50");
    button("Next")!.click();
    expect(dom.document.body.textContent).toContain("second-account");
    expect(dom.document.body.textContent).not.toContain("first-account");
    expect(paths).toHaveLength(1);
    const download = Array.from(dom.document.querySelectorAll("a")).find((node) => node.textContent?.includes("Download original XML"));
    expect(download?.getAttribute("href")).toContain(`sha256=${"a".repeat(64)}&download=original`);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
