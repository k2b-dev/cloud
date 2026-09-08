import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../../ui/test/dom";

describe("AI usage drill-down", () => {
  if (isServer) {
    test.skip("requires browser conditions and Solid DOM preload", () => {});
    return;
  }
  for (const view of ["runs", "feedback"] as const) {
    test(`opens complete ${view} details read-only and closes without navigation`, async () => {
      const dom = createDomTestHarness();
      const { usageFixture } = await import("./ai-usage-fixture");
      const { default: Explorer } = await import("./AiUsageExplorer.island.tsx");
      const { dialogCore } = await import("@k2b/ui");
      const report = usageFixture();
      report.query.view = view;
      report.query.userId = "11111111-1111-4111-8111-111111111111";
      report.runs.items[0]!.error = "Full error " + "long detail ".repeat(150);
      const dispose = render(() => createComponent(Explorer, { report }), dom.root);
      try {
        const links = Array.from(dom.root.querySelectorAll("a"));
        const next = links.find((link) => link.textContent === "Users & models")!;
        expect(next.href).toContain(`userId=${report.query.userId}`);
        expect(next.href).toContain("until=");
        const button = Array.from(dom.root.querySelectorAll("button")).find(
          (button) => button.textContent === (view === "runs" ? "Show error" : "Details"),
        );
        expect(button).toBeDefined();
        button!.click();
        expect(dialogCore.isOpen()).toBe(true);
        const dialog = dom.document.querySelector('dialog, [role="dialog"]');
        expect(dialog?.textContent).toContain(view === "runs" ? report.runs.items[0]!.error! : report.feedback.items[0]!.comment!);
        expect(dialog?.textContent).toContain("Copy details");
        expect(dialog?.querySelectorAll("input,textarea").length).toBe(0);
        dialogCore.close();
        expect(dialogCore.isOpen()).toBe(false);
      } finally {
        dialogCore.close();
        dispose();
        dom.cleanup();
      }
    });
  }
  test("shows one comparison table and switches to models", async () => {
    const dom = createDomTestHarness();
    const { usageFixture } = await import("./ai-usage-fixture");
    const { default: Explorer } = await import("./AiUsageExplorer.island.tsx");
    const report = usageFixture();
    report.query.view = "comparisons";
    const dispose = render(() => createComponent(Explorer, { report }), dom.root);
    try {
      expect(dom.root.querySelectorAll("table").length).toBe(1);
      expect(dom.root.textContent).not.toContain("provider/model-a");
      Array.from(dom.root.querySelectorAll("button"))
        .find((button) => button.textContent === "Models")!
        .click();
      expect(dom.root.querySelectorAll("table").length).toBe(1);
      expect(dom.root.textContent).toContain("provider/model-a");
      expect(dom.root.querySelector("details")?.open).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
