import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Load once outside any test, so the cold Solid transform of the library source does not count against the 5 s test
// timeout. The library needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("../src");
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Row = { id: string; name: string; count: number; team: string };

let cleanup = () => {};
afterEach(() => cleanup());

const rows = (count: (id: string) => number): Row[] => [
  { id: "a", name: "Alpha", count: count("a"), team: "Nord" },
  { id: "b", name: "Beta", count: count("b"), team: "Nord" },
  { id: "c", name: "Gamma", count: count("c"), team: "Süd" },
];

describe("@k2b/ui DataTable row identity", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  for (const grouped of [false, true]) {
    test(`new row objects with the same ids keep each row element, its focus and its open details${grouped ? " (grouped)" : ""}`, () => {
      const dom = createDomTestHarness();
      // The library registered its delegated click handler on the document it was loaded in.
      delegateEvents(["click"], dom.document);
      const { DataTable } = modules!;
      const [data, setData] = createSignal(rows(() => 1));
      const dispose = render(
        () => (
          <DataTable<Row>
            rows={data()}
            columns={[
              { id: "name", header: "Name", value: "name" },
              { id: "count", header: "Count", value: "count", priority: 2 },
              { id: "team", header: "Team", value: "team" },
            ]}
            getRowId={(row) => row.id}
            groupBy={grouped ? "team" : undefined}
            onRowClick={() => {}}
          />
        ),
        dom.root,
      );
      cleanup = () => {
        dispose();
        dom.cleanup();
        cleanup = () => {};
      };

      const bodyRows = () => [...dom.root.querySelectorAll<HTMLElement>("tr.k2b-data-table__row")];
      const groups = () => [...dom.root.querySelectorAll<HTMLElement>("tbody")];
      const before = bodyRows();
      const groupsBefore = groups();
      expect(before).toHaveLength(3);
      before[1]!.focus();
      expect(dom.document.activeElement).toBe(before[1]!);
      before[1]!.querySelector<HTMLButtonElement>(".k2b-data-table__details-button")!.click();
      expect(before[1]!.dataset.detailsOpen).toBe("true");

      setData(rows((id) => (id === "b" ? 42 : 1)));

      const after = bodyRows();
      expect(after).toHaveLength(3);
      after.forEach((row, index) => expect(row).toBe(before[index]!));
      expect(groups()).toEqual(groupsBefore);
      expect(dom.document.activeElement).toBe(before[1]!);
      expect(before[1]!.isConnected).toBe(true);
      expect(before[1]!.dataset.detailsOpen).toBe("true");
      expect(before[1]!.textContent).toContain("42");
    });
  }

  test("a row that moves keeps its element and a row that leaves drops only its own", () => {
    const dom = createDomTestHarness();
    const { DataTable } = modules!;
    const [data, setData] = createSignal(rows(() => 1));
    const dispose = render(
      () => <DataTable<Row> rows={data()} columns={[{ id: "name", header: "Name", value: "name" }]} getRowId={(row) => row.id} />,
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
      cleanup = () => {};
    };

    const bodyRows = () => [...dom.root.querySelectorAll<HTMLElement>("tr.k2b-data-table__row")];
    const [alpha, , gamma] = bodyRows();
    setData([
      { id: "c", name: "Gamma 2", count: 1, team: "Süd" },
      { id: "a", name: "Alpha", count: 1, team: "Nord" },
    ]);
    expect(bodyRows()).toEqual([gamma!, alpha!]);
    expect(gamma!.textContent).toBe("Gamma 2");
  });
});
