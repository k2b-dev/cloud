import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { WorkflowStarter } from "./workflow-starters";

const domTest = isServer ? test.skip : test;

domTest("financial starter blocks invalid bank data, retains field choices, and hands off a disabled workflow", async () => {
  const dom = createDomTestHarness();
  const prototype = dom.window.HTMLElement.prototype;
  const open = new WeakSet<object>();
  const matches = prototype.matches;
  prototype.matches = function (selector: string) {
    return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
  };
  Object.assign(prototype, {
    showPopover(this: object) {
      open.add(this);
    },
    hidePopover(this: object) {
      open.delete(this);
    },
    scrollIntoView() {},
  });
  const { FinancialWorkflowStarter } = await import("./FinancialWorkflowStarter");
  const results: WorkflowStarter[] = [];
  let dirty = 0;
  const fields = [
    { id: "NUM001", name: "Expense number", type: "text", required: true, uniqueConstraint: true },
    { id: "BAD001", name: "Non-unique reference", type: "text", required: true, uniqueConstraint: false },
    { id: "AMT001", name: "Total", type: "number", required: true, uniqueConstraint: false },
    { id: "PAY001", name: "Payee", type: "text", required: true, uniqueConstraint: false },
    { id: "IBAN01", name: "Bank account", type: "text", required: true, uniqueConstraint: false },
    { id: "REF001", name: "Reference", type: "text", required: true, uniqueConstraint: false },
  ];
  const dispose = render(
    () =>
      createComponent(FinancialWorkflowStarter, {
        kind: "expensePayment",
        tables: [{ id: "TBL001", name: "Expenses", kind: "stored" }],
        fieldsByTable: { TBL001: fields },
        onDirty: () => {
          dirty++;
        },
        onComplete: (starter) => results.push(starter),
      }),
    dom.root,
  );
  const button = (label: string) => {
    const found = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find(
      (element) => element.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  const choose = async (index: number, label: string) => {
    const control = dom.root.querySelectorAll<HTMLButtonElement>('[role="combobox"]')[index]!;
    control.click();
    await Bun.sleep(10);
    const listbox = dom.document.getElementById(control.getAttribute("aria-controls") ?? "");
    if (!listbox) throw new Error("Missing options list");
    const option = Array.from(listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (element) => element.textContent?.trim() === label,
    );
    if (!option) throw new Error(`Missing option ${label}`);
    option.click();
    await Bun.sleep(10);
  };
  try {
    expect(button("Configure destination").disabled).toBe(true);
    await choose(0, "Expenses");
    await choose(1, "Expense number");
    await choose(2, "Total");
    await choose(3, "Payee");
    await choose(4, "Bank account");
    await choose(5, "Reference");
    expect(button("Configure destination").disabled, dom.root.textContent ?? "").toBe(false);
    button("Configure destination").click();
    const fill = (index: number, value: string) => {
      const input = dom.root.querySelectorAll<HTMLInputElement>("input")[index]!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    fill(0, "main-bank");
    fill(1, "Example");
    fill(2, "invalid-iban");
    const dateTrigger = dom.root.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(dateTrigger).not.toBeNull();
    dateTrigger!.click();
    await Bun.sleep(10);
    const day = dom.document.querySelector<HTMLButtonElement>('[data-date-day]:not([data-outside="true"])');
    expect(day).not.toBeNull();
    const selectedDate = day!.getAttribute("data-date-day");
    day!.click();
    await Bun.sleep(10);
    button("Review workflow").click();
    expect(results).toHaveLength(0);
    expect(dom.root.textContent).toContain("Check the marked destination fields");
    expect(dom.root.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
    expect(dom.document.activeElement).toBe(dom.root.querySelectorAll<HTMLInputElement>("input")[2] ?? null);
    fill(2, "DE89370400440532013000");
    button("Back to fields").click();
    expect(dom.root.textContent).toContain("Expense number");
    button("Configure destination").click();
    expect(dom.root.querySelectorAll<HTMLInputElement>("input")[2]?.value).toBe("DE89370400440532013000");
    button("Review workflow").click();
    expect(results).toHaveLength(1);
    expect(results[0]?.enabled).toBe(false);
    expect(results[0]?.source).toContain("sourceVersions: data");
    expect(results[0]?.source).toContain(selectedDate!);
    expect(results[0]?.launcher.config).toEqual({ kind: "bulk", input: "records" });
    expect(dirty).toBeGreaterThan(0);
  } finally {
    dispose();
    dom.cleanup();
  }
});
