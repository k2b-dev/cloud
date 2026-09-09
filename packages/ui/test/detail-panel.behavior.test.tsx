import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("DetailPanel section disclosure", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }
  test("preserves controls and focus across uncontrolled toggles", async () => {
    const dom = createDomTestHarness();
    const { default: DetailPanel } = await import("../src/layout/DetailPanel");
    const dispose = render(
      () => (
        <DetailPanel.Section title="Settings" collapsible>
          <input value="Draft" />
        </DetailPanel.Section>
      ),
      dom.root,
    );
    try {
      const expand = dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
      const collapse = dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!;
      const body = document.getElementById(expand.getAttribute("aria-controls")!)!;
      const input = body.querySelector("input")!;
      expect(body.hidden).toBe(true);
      expand.focus();
      expand.click();
      await Promise.resolve();
      expect(body.hidden).toBe(false);
      expect(document.activeElement).toBe(collapse);
      input.value = "Unsaved changes";
      collapse.click();
      await Promise.resolve();
      expect(body.hidden).toBe(true);
      expect(document.activeElement).toBe(expand);
      expand.click();
      expect(body.querySelector("input")).toBe(input);
      expect(input.value).toBe("Unsaved changes");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("respects controlled state, refusal and disabled toggles", async () => {
    const dom = createDomTestHarness();
    const { default: DetailPanel } = await import("../src/layout/DetailPanel");
    const [open, setOpen] = createSignal(false);
    const [disabled, setDisabled] = createSignal(false);
    const requests: boolean[] = [];
    const dispose = render(
      () => (
        <DetailPanel.Section title="Source" collapsible open={open()} disabled={disabled()} onOpenChange={(next) => requests.push(next)}>
          <input />
        </DetailPanel.Section>
      ),
      dom.root,
    );
    try {
      const expand = dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
      const body = document.getElementById(expand.getAttribute("aria-controls")!)!;
      expand.click();
      expect(requests).toEqual([true]);
      expect(body.hidden).toBe(true);
      setOpen(true);
      expect(body.hidden).toBe(false);
      setDisabled(true);
      dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!.click();
      expect(requests).toEqual([true]);
      expect(body.hidden).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
