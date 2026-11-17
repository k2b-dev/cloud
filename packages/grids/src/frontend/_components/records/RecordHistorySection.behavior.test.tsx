import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicRecordHistoryEntry } from "../../../api/public-audit";

const domTest = isServer ? test.skip : test;
const NOW = "2026-11-12T15:31:00.000Z";
beforeAll(() => setSystemTime(new Date(NOW)));
afterAll(() => setSystemTime());

const published = (): PublicRecordHistoryEntry => ({
  id: "00000000-0000-4000-8000-000000000001",
  baseId: "BASE01",
  tableId: "TABLE1",
  recordId: "REC001",
  userId: null,
  action: "updated",
  diff: { FIELD1: { old: ["Open", "Waiting"], new: "Done" } },
  ip: null,
  userAgent: null,
  createdAt: "2026-11-12T14:00:00.000Z",
  context: {
    operation: "update",
    answers: [{ label: "Reason", type: "select", required: true, value: "checked", optionLabel: "Checked by the team" }],
  },
  source: { ref: "source1", baseName: "Inventory", tableName: "Orders" },
  recordDeletedAt: "2026-11-12T15:00:00.000Z",
});

domTest("published history keeps its source, answers, field changes, and deleted-record action", async () => {
  const dom = createDomTestHarness();
  const { RecordHistoryList } = await import("./RecordHistorySection");
  const opened: [string, boolean][] = [];
  const [entries, setEntries] = createSignal([published()]);
  const dispose = render(
    () =>
      createComponent(RecordHistoryList, {
        get entries() {
          return entries();
        },
        fields: [],
        now: NOW,
        dateConfig: { locale: "en", timeZone: "UTC" },
        onOpenRecord: (id, deleted) => opened.push([id, deleted]),
      }),
    dom.root,
  );
  try {
    expect(dom.root.textContent).toContain("Published from Inventory · Orders");
    expect(dom.root.textContent).toContain("Changed: Unavailable field");
    expect(dom.root.textContent).not.toContain("FIELD1");
    expect(dom.root.textContent).not.toContain("Checked by the team");
    const action = dom.root.querySelector<HTMLButtonElement>(".k2b-activity__action")!;
    const toggle = dom.root.querySelector<HTMLButtonElement>(".k2b-activity__text-button")!;
    action.click();
    expect(opened).toEqual([["REC001", true]]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dom.root.textContent).toContain("ReasonChecked by the team");
    expect(dom.root.textContent).toContain("Open, Waiting → Done");
    // A fresh server page rebuilds the DTOs, but the same event keeps its node and open details.
    setEntries([published()]);
    expect(dom.root.querySelector(".k2b-activity__text-button")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dom.root.textContent).toContain("Open, Waiting → Done");
    toggle.click();
    expect(dom.root.textContent).not.toContain("Checked by the team");
  } finally {
    dispose();
    dom.cleanup();
  }
});
