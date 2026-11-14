import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

describe("Section disclosure", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }
  test("is one heading button that keeps focus and the body's controls across uncontrolled toggles", async () => {
    const dom = createDomTestHarness();
    const { Section } = await import("../src/surfaces/Section");
    const dispose = render(
      () => (
        <Section title="Settings" collapsible>
          <input value="Draft" />
        </Section>
      ),
      dom.root,
    );
    try {
      const toggles = dom.root.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
      expect(toggles).toHaveLength(1);
      const toggle = toggles[0]!;
      // The button sits inside the heading, so the region keeps its name and heading navigation finds it.
      expect(toggle.parentElement?.tagName).toBe("H3");
      const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      const input = body.querySelector("input")!;
      expect(body.hidden).toBe(true);
      toggle.focus();
      toggle.click();
      await Promise.resolve();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(body.hidden).toBe(false);
      expect(document.activeElement).toBe(toggle);
      input.value = "Unsaved changes";
      input.focus();
      toggle.click();
      await Promise.resolve();
      expect(body.hidden).toBe(true);
      expect(document.activeElement).toBe(toggle);
      toggle.click();
      expect(body.querySelector("input")).toBe(input);
      expect(input.value).toBe("Unsaved changes");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("respects controlled state, refusal and disabled toggles", async () => {
    const dom = createDomTestHarness();
    const { Section } = await import("../src/surfaces/Section");
    const [open, setOpen] = createSignal(false);
    const [disabled, setDisabled] = createSignal(false);
    const requests: boolean[] = [];
    // A fresh harness document without registered delegation: the toggle must still answer clicks.
    const dispose = render(
      () => (
        <Section title="Source" collapsible open={open()} disabled={disabled()} onOpenChange={(next) => requests.push(next)}>
          <input />
        </Section>
      ),
      dom.root,
    );
    try {
      const toggle = dom.root.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
      const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      toggle.click();
      expect(requests).toEqual([true]);
      expect(body.hidden).toBe(true);
      setOpen(true);
      expect(body.hidden).toBe(false);
      setDisabled(true);
      toggle.click();
      expect(requests).toEqual([true]);
      expect(body.hidden).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("returns focus to the toggle when the parent closes it while focus is inside", async () => {
    const dom = createDomTestHarness();
    const { Section } = await import("../src/surfaces/Section");
    const [open, setOpen] = createSignal(true);
    const dispose = render(
      () => (
        <Section title="Editor" collapsible open={open()}>
          <input />
        </Section>
      ),
      dom.root,
    );
    try {
      dom.root.querySelector("input")!.focus();
      setOpen(false);
      await Promise.resolve();
      await Promise.resolve();
      expect(document.activeElement).toBe(dom.root.querySelector("button[aria-expanded]"));
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("a retry in the error state calls back, and the ready state shows the body again", async () => {
    const dom = createDomTestHarness();
    const { Section } = await import("../src/surfaces/Section");
    const [state, setState] = createSignal<"error" | "ready">("error");
    let retries = 0;
    const dispose = render(
      () => (
        <Section title="Files" state={state()} onRetry={() => retries++}>
          <span class="loaded">Offer.pdf</span>
        </Section>
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector(".loaded")).toBeNull();
      dom.root.querySelector<HTMLButtonElement>(".k2b-section__footer button")!.click();
      expect(retries).toBe(1);
      setState("ready");
      expect(dom.root.querySelector(".loaded")?.textContent).toBe("Offer.pdf");
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});

test("a secondary action runs its own command without activating the row", async () => {
  const dom = createDomTestHarness();
  const { DetailPanel } = await import("../src");
  const calls: string[] = [];
  const dispose = render(
    () => (
      <DetailPanel.Action
        title="report.pdf"
        onClick={() => calls.push("open")}
        secondaryAction={{ icon: "ti ti-trash", label: "Delete file", variant: "danger", onClick: () => calls.push("delete") }}
      />
    ),
    dom.root,
  );
  try {
    const buttons = Array.from(dom.root.querySelectorAll<HTMLButtonElement>(".k2b-detail-panel__action-row > button"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([null, "Delete file"]);
    const secondary = buttons[1]!;
    expect(secondary.tabIndex).toBe(0);
    secondary.focus();
    expect(document.activeElement).toBe(secondary);
    secondary.click();
    expect(calls).toEqual(["delete"]);
    buttons[0]!.click();
    expect(calls).toEqual(["delete", "open"]);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a section instantiates its body once even though it renders the body conditionally", async () => {
  const dom = createDomTestHarness();
  const { DetailPanel, Section } = await import("../src");
  let created = 0;
  const dispose = render(
    () => (
      <DetailPanel>
        <DetailPanel.Body>
          <Section title="Preview">
            {(() => {
              created++;
              return <span>body</span>;
            })()}
          </Section>
          <Section title="Empty" />
        </DetailPanel.Body>
      </DetailPanel>
    ),
    dom.root,
  );
  expect(created).toBe(1);
  expect(dom.root.querySelectorAll(".k2b-section__body")).toHaveLength(1);
  dispose();
  dom.cleanup();
});

test("a row's checkbox toggles on its own, shows its state, and leaves the row its own command", async () => {
  const dom = createDomTestHarness();
  const { DetailPanel } = await import("../src");
  const { createSignal } = await import("solid-js");
  const calls: string[] = [];
  const [done, setDone] = createSignal(false);
  const dispose = render(
    () => (
      <DetailPanel.Action
        title="Call Mrs. Weber"
        onClick={() => calls.push("open")}
        checkbox={{
          get checked() {
            return done();
          },
          label: "Done: Call Mrs. Weber",
          onChange: (checked) => {
            calls.push(`done:${checked}`);
            setDone(checked);
          },
        }}
      />
    ),
    dom.root,
  );
  try {
    const row = dom.root.querySelector<HTMLElement>(".k2b-detail-panel__action-row")!;
    const box = row.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    // The checkbox comes first, as its own control beside the row's button, never inside it.
    expect(row.firstElementChild?.classList.contains("k2b-detail-panel__action-check")).toBe(true);
    expect(box.closest("button")).toBeNull();
    expect(box.getAttribute("aria-label")).toBe("Done: Call Mrs. Weber");
    expect(box.checked).toBe(false);
    box.click();
    expect(calls).toEqual(["done:true"]);
    expect(box.checked).toBe(true);
    row.querySelector<HTMLButtonElement>("button.k2b-detail-panel__action")!.click();
    expect(calls).toEqual(["done:true", "open"]);
  } finally {
    dispose();
    dom.cleanup();
  }
});
