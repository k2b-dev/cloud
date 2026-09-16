import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../_components/ssr-test-plugin";

const { default: BackgroundAction } = await import("./BackgroundAction");
const { default: RecordsTable } = await import("./RecordsTable.island.tsx");

test("background actions render all durable states without browser globals", () => {
  for (const status of ["draft", "running", "failed", "missing", "attention", "ready"] as const) {
    const html = renderToString(() =>
      createComponent(BackgroundAction, {
        label: "Issue invoice",
        endpoint: "/action",
        acceptedMessage: "Creation requested; you can keep working.",
        state:
          status === "ready"
            ? { status, document: { id: "DOC001", number: "RE-001", blockId: "identity" }, downloadUrl: "/document.pdf" }
            : { status },
      }),
    );
    expect(html).not.toBeEmpty();
    if (status === "running") expect(html).toContain("Creation requested; you can keep working.");
    if (status === "ready") expect(html).toContain('href="/document.pdf"');
  }
});

test("workflow status lists can be rendered and disposed on the server", () => {
  const html = renderToString(() =>
    createComponent(RecordsTable, {
      title: "Bills",
      emptyText: "No bills",
      baseId: "BASE01",
      appId: "APP001",
      endpoint: "/records",
      result: { ok: true, mode: "rows", limit: 25, columns: [], rows: [], workflowStates: {} },
    }),
  );
  expect(html).not.toBeEmpty();
});
