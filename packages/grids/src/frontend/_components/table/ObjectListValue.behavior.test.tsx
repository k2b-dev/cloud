import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("object-list table disclosure and row pagination preserve the stored values", async () => {
  const dom = createDomTestHarness();
  const { ObjectListValue } = await import("./ObjectListValue");
  const dispose = render(
    () => (
      <ObjectListValue
        detail
        layout="table"
        ariaLabel="Positions"
        value={Array.from({ length: 26 }, () => ({ Amount: "1", Total1: "2" }))}
        config={{
          fields: [
            { id: "Amount", name: "Quantity", type: "number" },
            { id: "Total1", name: "Stored calculation", type: "number", formula: { expression: "Amount * 999" }, detailsOnly: true },
          ],
        }}
      />
    ),
    dom.root,
  );
  try {
    expect(dom.root.querySelectorAll("tbody tr").length).toBe(25);
    expect(dom.root.textContent).not.toContain("Stored calculation");
    dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click();
    await Promise.resolve();
    expect(dom.root.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(dom.root.textContent).toContain("Stored calculation");
    expect(dom.root.querySelector("tbody tr td:last-child")?.textContent).toBe("2");
    expect(dom.root.textContent).not.toContain("999");
    Array.from(dom.root.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Show more rows"))!
      .click();
    await Promise.resolve();
    expect(dom.root.querySelectorAll("tbody tr").length).toBe(26);
    expect(dom.root.textContent).not.toContain("Show more rows");
  } finally {
    dispose();
    dom.cleanup();
  }
});
