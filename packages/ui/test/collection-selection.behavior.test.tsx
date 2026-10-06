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

test("a single checklist toggles with a click, moves focus with arrows, skips disabled items, and leaves Escape to the host", async () => {
  const dom = createDomTestHarness();
  delegateEvents(["click", "dblclick", "keydown"], dom.document);
  const rows = ["a", "b", "c"];
  const disabled = new Set(["b"]);
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
      isDisabled={(row) => disabled.has(row)}
      renderPreview={() => null}
      renderLabel={(row) => row}
      onOpen={(row) => opened.push(row)}
    />
  );
  const dispose = render(() => {
    const ids = () => rows.filter((row) => !disabled.has(row));
    single = createCollectionSelection({ ids, multiple: false, checklist: true });
    many = createCollectionSelection({ ids, checklist: true });
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

  // A disabled item is marked, cannot be selected or opened, and is not a focus stop.
  const blocked = cells(singleGrid!)[1]!;
  expect(blocked.getAttribute("aria-disabled")).toBe("true");
  blocked.click();
  blocked.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(single.selected().size).toBe(0);
  expect(opened).toEqual([]);

  // One item at most: a click toggles it, another click replaces it, and Ctrl-A selects nothing more.
  cells(singleGrid!)[0]!.click();
  cells(singleGrid!)[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
  expect([...single.selected()]).toEqual(["c"]);
  cells(singleGrid!)[2]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", ctrlKey: true }));
  expect([...single.selected()]).toEqual(["c"]);
  cells(singleGrid!)[2]!.click();
  expect(single.selected().size).toBe(0);

  // A checklist adds with plain clicks; arrows only move focus, past the disabled item; Space toggles.
  cells(manyGrid!)[0]!.click();
  cells(manyGrid!)[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
  expect(dom.document.activeElement).toBe(cells(manyGrid!)[2]!);
  expect([...many.selected()]).toEqual(["a"]);
  cells(manyGrid!)[2]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " }));
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
