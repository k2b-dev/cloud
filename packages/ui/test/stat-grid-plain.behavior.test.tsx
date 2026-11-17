import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("../src");
  } finally {
    dom.cleanup();
  }
};
const { StatCell, StatGrid } = await load();

test("changing the grid variant updates the existing cell and moves its delta between rows", () => {
  const dom = createDomTestHarness();
  const [variant, setVariant] = createSignal<"tiles" | "plain">("tiles");
  const dispose = render(
    () => (
      <StatGrid variant={variant()} surface="muted">
        <StatCell label="Open" value={12} tone="amber" delta={{ value: 0.1 }} />
      </StatGrid>
    ),
    dom.root,
  );
  try {
    const cell = dom.root.querySelector(".k2b-stat-cell")!;
    expect(cell.getAttribute("data-surface")).toBe("muted");
    expect(cell.querySelector(".k2b-stat-cell__main .k2b-stat-cell__delta")).not.toBeNull();
    setVariant("plain");
    expect(dom.root.querySelector(".k2b-stat-cell")).toBe(cell);
    expect(cell.getAttribute("data-variant")).toBe("plain");
    expect(cell.getAttribute("data-surface")).toBeNull();
    expect(cell.getAttribute("data-tone")).toBe("amber");
    expect(cell.querySelector(".k2b-stat-cell__main .k2b-stat-cell__delta")).toBeNull();
    expect(cell.querySelector(".k2b-stat-cell__support .k2b-stat-cell__delta")).not.toBeNull();
    setVariant("tiles");
    expect(cell.getAttribute("data-variant")).toBeNull();
    expect(cell.getAttribute("data-surface")).toBe("muted");
    expect(cell.querySelector(".k2b-stat-cell__main .k2b-stat-cell__delta")).not.toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
