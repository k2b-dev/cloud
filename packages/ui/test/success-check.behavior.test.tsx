import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// `celebrate` swaps a success glyph for the check that draws itself; without it every success looks as before.
// The drawing itself, and that reduced motion skips it, is CSS: see success-check.browser.test.ts.
describe("@k2b/ui success check", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  afterEach(async () => {
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { toast } = await import("../src/feedback/toast");
    dialogCore.close();
    toast.dismissAll();
    await Bun.sleep(220);
  });

  test("a toast draws the check only when asked, and keeps it through updates", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const lead = (handle: number) => dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast] .k2b-toast__icon")[handle]!;

    toast.success("Saved", { duration: 0 });
    expect(lead(0).innerHTML).toBe('<i class="ti ti-check"></i>');

    toast.success("Invoice RE-2026-0142 issued", { duration: 0, celebrate: true });
    const check = lead(1).firstElementChild!;
    expect(lead(1).childElementCount).toBe(1);
    expect(check.getAttribute("class")).toBe("k2b-success-check");
    expect(check.getAttribute("aria-hidden")).toBe("true");
    expect(Array.from(check.children, (part) => part.getAttribute("class"))).toEqual([
      "k2b-success-check__ring",
      "k2b-success-check__mark",
    ]);
    // Screen readers hear the message alone, with or without the check.
    await Bun.sleep(120);
    const spoken = dom.document.querySelector('[data-k2b-live] [data-politeness="polite"]');
    expect(Array.from(spoken?.children ?? [], (line) => line.textContent)).toEqual(["Saved", "Invoice RE-2026-0142 issued"]);

    // Running work keeps its spinner; the check appears with the finished result, once.
    const handle = toast("Creating the SEPA file", { duration: 0, progress: "indeterminate", celebrate: true });
    expect(lead(2).querySelector(".k2b-success-check")).toBeNull();
    handle.update("SEPA file created", { variant: "success", progress: null, celebrate: true });
    const drawn = lead(2).querySelector(".k2b-success-check");
    expect(drawn).not.toBeNull();
    handle.update("SEPA file created: 14 payments");
    expect(lead(2).querySelector(".k2b-success-check")).toBe(drawn);
    handle.update("SEPA file could not be saved", { variant: "error" });
    expect(lead(2).innerHTML).toBe('<i class="ti ti-alert-circle"></i>');

    // Other variants ignore it.
    toast.error("Not issued", { duration: 0, celebrate: true });
    expect(dom.document.querySelectorAll(".k2b-success-check")).toHaveLength(1);
    dom.cleanup();
  });

  test("prompts.success and a success PanelDialog draw the check only when asked", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { prompts } = await import("../src/feedback/prompts");
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { default: PanelDialog } = await import("../src/layout/PanelDialog");
    const headerIcon = () => dom.document.querySelector("dialog[open] .k2b-dialog__header")!.firstElementChild!;

    void prompts.success("Saved.");
    await Bun.sleep(10);
    expect(headerIcon().tagName).toBe("I");
    expect(headerIcon().className).toBe("ti ti-circle-check");
    dialogCore.close();

    void prompts.success("Customer K-1042 created.", { celebrate: true });
    await Bun.sleep(10);
    expect(headerIcon().getAttribute("class")).toBe("k2b-success-check");
    // The tone stays named for screen readers.
    expect(dom.document.querySelector("dialog[open] [data-dialog-tone-label]")?.textContent).toBe("Success");
    dialogCore.close();

    const panel = (props: { tone?: "success" | "warning"; celebrate?: boolean }) =>
      createComponent(PanelDialog, {
        ...props,
        get children() {
          return createComponent(PanelDialog.Header, { title: "Invoice issued", icon: "ti ti-file-invoice" });
        },
      });
    const tile = (props: Parameters<typeof panel>[0]) => {
      const host = dom.document.createElement("div");
      dom.root.append(host);
      render(() => panel(props), host);
      return host.querySelector(".k2b-panel-dialog__icon")!.innerHTML;
    };
    expect(tile({ tone: "success" })).toBe('<i class="ti ti-circle-check"></i>');
    expect(tile({ tone: "success", celebrate: true })).toStartWith('<svg class="k2b-success-check"');
    expect(tile({ tone: "warning", celebrate: true })).toBe('<i class="ti ti-alert-triangle"></i>');
    expect(tile({ celebrate: true })).toBe('<i class="ti ti-file-invoice"></i>');
    dom.cleanup();
  });
});
