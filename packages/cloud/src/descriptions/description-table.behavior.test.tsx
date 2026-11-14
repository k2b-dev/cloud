import { afterEach, describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { DescriptionJson } from "./json";

// Load once outside any test, so the cold Solid transform does not count against the test timeout. The modules need
// a document while they evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("./index");
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

let cleanup = () => {};
afterEach(() => cleanup());

// Raw values whose text order differs from what the columns show: an ISO time with an offset sorts by its instant,
// and a status by its label.
const spec: DescriptionJson = {
  block: "table",
  title: "Payments",
  search: true,
  columns: [
    { id: "name", label: "Payment", type: "text" },
    { id: "due", label: "Due", type: "date", timeZone: "UTC" },
    {
      id: "status",
      label: "Status",
      type: "status",
      states: {
        k1: { label: "Planned", tone: "neutral" },
        k2: { label: "Expected", tone: "info" },
        k3: { label: "Booked", tone: "success" },
      },
    },
  ],
  rows: [
    // 3 Nov, 23:30 UTC
    { name: "Rent", due: "2026-11-03T23:30:00Z", status: "k1" },
    // 3 Nov, 23:00 UTC: earlier, although its text sorts after Rent's
    { name: "Wages", due: "2026-11-04T01:00:00+02:00", status: "k2" },
    // 28 Oct
    { name: "Taxes", due: "2026-10-28T09:00:00Z", status: "k3" },
  ],
};

const mount = () => {
  const dom = createDomTestHarness();
  // The libraries registered their delegated handlers on the document they were loaded in.
  delegateEvents(["click", "input"], dom.document);
  const { DescriptionPanel } = modules!;
  const dispose = render(() => <DescriptionPanel spec={spec} title="Payments" height={0} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
    cleanup = () => {};
  };
  const content = () => dom.root.querySelector(".k2b-dashboard-frame__content");
  // Without a match the frame shows its empty sentence instead of the table.
  const names = () => Array.from(content()?.querySelectorAll("tbody tr") ?? []).map((row) => row.querySelector("td")?.textContent?.trim());
  const sortBy = (label: string) => {
    const header = Array.from(content()!.querySelectorAll("th")).find((cell) => cell.textContent?.includes(label))!;
    header.querySelector<HTMLButtonElement>("button")!.click();
    return header.getAttribute("aria-sort");
  };
  const search = (query: string) => {
    const input = dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { names, sortBy, search, text: () => dom.root.textContent ?? "" };
};

describe("DescriptionPanel table block", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a date column sorts by time, not by the text of its raw value", () => {
    const table = mount();
    const direction = table.sortBy("Due");
    const ascending = ["Taxes", "Wages", "Rent"];
    expect(table.names()).toEqual(direction === "ascending" ? ascending : [...ascending].reverse());
  });

  test("a status column sorts by the label it shows", () => {
    const table = mount();
    const direction = table.sortBy("Status");
    // Booked, Expected, Planned
    const ascending = ["Taxes", "Wages", "Rent"];
    expect(table.names()).toEqual(direction === "ascending" ? ascending : [...ascending].reverse());
  });

  test("search finds a date by its shown text and a status by its label", () => {
    const table = mount();
    table.search("Oct");
    expect(table.names()).toEqual(["Taxes"]);
    table.search("expected");
    expect(table.names()).toEqual(["Wages"]);
    // The raw key of a status is not what anyone reads.
    table.search("k3");
    expect(table.names()).toEqual([]);
    expect(table.text()).toContain("k3");
  });
});
