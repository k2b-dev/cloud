import { afterEach, expect, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
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
const { createCollectionSelection, DataTable, FileGrid, FileView } = await load();

let cleanup = () => {};
afterEach(() => cleanup());

test("table and grid share ranges, modifiers, focus, and pruning without treating nested controls as row clicks", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click"], dom.document);
  const [rows, setRows] = createSignal(["a", "b", "c", "d"]);
  const [grid, setGrid] = createSignal(false);
  let selection!: ReturnType<typeof createCollectionSelection>;
  let opened = "";
  const dispose = render(() => {
    selection = createCollectionSelection({ ids: rows });
    return (
      <Show
        when={grid()}
        fallback={
          <DataTable
            rows={rows()}
            columns={[{ id: "name", header: "Name" }]}
            getRowId={(row) => row}
            selection={selection}
            onRowDoubleClick={(row) => (opened = row)}
            renderCell={({ row }) => (
              <span>
                {row}
                <button type="button">Action</button>
              </span>
            )}
          />
        }
      >
        <FileGrid
          rows={rows()}
          getRowId={(row) => row}
          selection={selection}
          label="Files"
          renderPreview={() => null}
          renderLabel={(row) => row}
          onOpen={(row) => (opened = row)}
        />
      </Show>
    );
  }, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const tableRows = () => Array.from(dom.root.querySelectorAll<HTMLElement>("tbody tr"));
  tableRows()[0]!.click();
  tableRows()[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  expect([...selection.selected()]).toEqual(["a", "b", "c"]);
  tableRows()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  expect([...selection.selected()]).toEqual(["a", "c"]);
  tableRows()[3]!.querySelector("button")!.click();
  expect([...selection.selected()]).toEqual(["a", "c"]);
  setGrid(true);
  expect(dom.root.querySelectorAll('[aria-selected="true"]')).toHaveLength(2);
  const cells = () => Array.from(dom.root.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  cells()[1]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  expect([...selection.selected()]).toEqual(["c"]);
  expect(dom.document.activeElement).toBe(cells()[2]!);
  cells()[2]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  expect(opened).toBe("c");
  cells()[2]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", ctrlKey: true }));
  expect(selection.selected().size).toBe(4);
  setRows(["a", "d"]);
  expect([...selection.selected()]).toEqual(["a", "d"]);
  cells()[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  expect(selection.selected().size).toBe(0);
  setGrid(false);
  expect(tableRows().filter((row) => row.tabIndex === 0)).toHaveLength(1);
});

test("signed native previews support anonymous CORS and report a failure without fetching through load", async () => {
  const dom = createDomTestHarness();
  let errors = 0,
    reads = 0;
  const dispose = render(
    () => (
      <FileView
        file={{ path: "image.png", size: 12 }}
        previewHref="https://files.test/lease"
        crossOrigin="anonymous"
        onPreviewError={() => errors++}
        load={async () => {
          reads++;
          return { encoding: "base64", content: "", mediaType: "image/png" };
        }}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const img = dom.root.querySelector("img")!;
  expect(img.getAttribute("crossorigin")).toBe("anonymous");
  img.dispatchEvent(new Event("error"));
  expect(errors).toBe(1);
  expect(reads).toBe(0);
});

test("a single checklist toggles with a click, moves focus with arrows, keeps disabled items reachable, and leaves Escape to the host", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "dblclick", "keydown"], dom.document);
  const rows = ["a", "b", "c"];
  const isDisabled = (id: string) => id === "b";
  let single!: ReturnType<typeof createCollectionSelection>;
  let many!: ReturnType<typeof createCollectionSelection>;
  const opened: string[] = [];
  const grid = (selection: ReturnType<typeof createCollectionSelection>, label: string) => (
    <FileGrid
      rows={rows}
      getRowId={(row) => row}
      selection={selection}
      label={label}
      layout="list"
      renderPreview={() => null}
      renderLabel={(row) => row}
      onOpen={(row) => opened.push(row)}
    />
  );
  const dispose = render(() => {
    single = createCollectionSelection({ ids: () => rows, isDisabled, multiple: false, checklist: true });
    many = createCollectionSelection({ ids: () => rows, isDisabled, checklist: true });
    return (
      <>
        {grid(single, "Single")}
        {grid(many, "Many")}
      </>
    );
  }, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const [singleGrid, manyGrid] = Array.from(dom.root.querySelectorAll<HTMLElement>('[role="grid"]'));
  expect(singleGrid!.dataset.layout).toBe("list");
  expect(singleGrid!.getAttribute("aria-multiselectable")).toBe("false");
  expect(manyGrid!.getAttribute("aria-multiselectable")).toBe("true");
  const cells = (grid: HTMLElement) => Array.from(grid.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  const key = (cell: HTMLElement, init: KeyboardEventInit) => cell.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

  // A disabled item is marked and cannot be selected or opened by click, double-click, Space, or Enter.
  const blocked = cells(singleGrid!)[1]!;
  expect(blocked.getAttribute("aria-disabled")).toBe("true");
  cells(singleGrid!)[0]!.click();
  blocked.click();
  blocked.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  key(blocked, { key: " " });
  key(blocked, { key: "Enter" });
  expect([...single.selected()]).toEqual(["a"]);
  expect(opened).toEqual([]);

  // One item at most: another click replaces it, Ctrl-A selects nothing more, and a second click clears it.
  cells(singleGrid!)[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  expect([...single.selected()]).toEqual(["c"]);
  key(cells(singleGrid!)[2]!, { key: "a", ctrlKey: true });
  expect([...single.selected()]).toEqual(["c"]);
  cells(singleGrid!)[2]!.click();
  expect(single.selected().size).toBe(0);

  // A checklist adds with plain clicks. Arrows only move focus and stop on the disabled item, so the keyboard and
  // screen readers reach its reason; Space toggles; select-all and ranges leave the disabled item out.
  cells(manyGrid!)[0]!.click();
  key(cells(manyGrid!)[0]!, { key: "ArrowDown" });
  expect(dom.document.activeElement).toBe(cells(manyGrid!)[1]!);
  key(cells(manyGrid!)[1]!, { key: "ArrowDown" });
  expect(dom.document.activeElement).toBe(cells(manyGrid!)[2]!);
  expect([...many.selected()]).toEqual(["a"]);
  key(cells(manyGrid!)[2]!, { key: " " });
  expect([...many.selected()]).toEqual(["a", "c"]);
  many.clear();
  key(cells(manyGrid!)[2]!, { key: "a", ctrlKey: true });
  expect([...many.selected()]).toEqual(["a", "c"]);
  many.clear();
  cells(manyGrid!)[0]!.click();
  cells(manyGrid!)[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  expect([...many.selected()]).toEqual(["a", "c"]);

  // Escape clears a selection first; with nothing selected it is left to the host, for example a dialog.
  const escape = () => new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" });
  const first = escape();
  cells(manyGrid!)[2]!.dispatchEvent(first);
  expect(first.defaultPrevented).toBe(true);
  expect(many.selected().size).toBe(0);
  const second = escape();
  cells(manyGrid!)[2]!.dispatchEvent(second);
  expect(second.defaultPrevented).toBe(false);
});

test("a double-click whose first click replaced the rows does not act on the row that moved under the pointer", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "dblclick"], dom.document);
  const [folder, setFolder] = createSignal("root");
  const listing: Record<string, string[]> = { root: ["docs", "photos"], docs: ["drafts", "notes.txt"] };
  const opened: string[] = [];
  const dispose = render(() => {
    const selection = createCollectionSelection({ ids: () => listing[folder()] ?? [] });
    const open = (row: string) => {
      opened.push(row);
      if (listing[row]) setFolder(row);
    };
    return (
      <FileGrid
        rows={listing[folder()] ?? []}
        getRowId={(row) => row}
        selection={selection}
        label="Files"
        layout="list"
        renderPreview={() => null}
        renderLabel={(row) => row}
        onRowClick={open}
        onOpen={open}
      />
    );
  }, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const first = () => dom.root.querySelector<HTMLElement>('[role="gridcell"]')!;
  const press = (detail: number) => first().dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));

  // The first click opens "docs"; the second click and the double-click land on "drafts", which took neither.
  press(1);
  expect(folder()).toBe("docs");
  press(2);
  first().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  expect(opened).toEqual(["docs"]);
  expect(folder()).toBe("docs");

  // The next gesture on that row works as usual.
  press(1);
  expect(opened).toEqual(["docs", "drafts"]);
});
