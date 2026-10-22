import { afterEach, expect, mock, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult, FileEntry } from "../src/contracts";
import { browserWithUploads } from "./browser-with-uploads";

const branchRequests: Array<{ input: unknown; signal: AbortSignal; resolve: (response: Response) => void }> = [];
const favoriteRequests: Array<{ input: unknown; resolve: (response: Response) => void }> = [];
const requests: Array<{ signal: AbortSignal; input: unknown; resolve: (response: Response) => void }> = [];
mock.module("../src/api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": {
        entries: {
          $get: (input: unknown, options: { init: { signal: AbortSignal } }) =>
            new Promise<Response>((resolve) => branchRequests.push({ input, signal: options.init.signal, resolve })),
        },
        favorite: { $post: (input: unknown) => new Promise<Response>((resolve) => favoriteRequests.push({ input, resolve })) },
        entry: {
          $get: (input: unknown, options: { init: { signal: AbortSignal } }) =>
            new Promise<Response>((resolve) => requests.push({ input, signal: options.init.signal, resolve })),
        },
      },
    },
  },
}));
const initial: DirectoryResult = {
  base: {
    id: "home",
    name: "Home",
    area: "cloud",
    kind: "users",
    status: "existing",
    reason: null,
    indexEnabled: false,
    versioningEnabled: false,
  },
  path: "",
  items: ["A.txt", "B.txt"].map((name) => ({ name, path: name, directory: false, size: 3, modified: "2026-09-18T00:00:00Z" })),
  next: null,
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  requests.length = 0;
  favoriteRequests.length = 0;
  branchRequests.length = 0;
});

test("view changes preserve selection; superseded details cannot replace current content; navigation clears selection", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const [directory, setDirectory] = createSignal(initial);
  const [source, setSource] = createSignal("/app/filesv2?base=home");
  const dispose = render(
    () => (
      <Browser directory={directory()} bases={[initial.base]} cloudUrl="https://cloud.test" source={source()} onNavigate={async () => {}} />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  expect(requests).toHaveLength(0);
  const rows = [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")];
  const header = dom.root.querySelector(".filesv2-browser__header")!;
  const headerBlocks = header.childElementCount;
  rows[0]!.click();
  await flush();
  expect(requests).toHaveLength(1);
  // Selecting a folder must not grow the header; a shifted list breaks the second click of a double-click.
  expect(header.childElementCount).toBe(headerBlocks);
  rows[1]!.click();
  await flush();
  expect(requests).toHaveLength(2);
  expect(requests[0]!.signal.aborted).toBeTrue();
  requests[1]!.resolve(Response.json({ base: initial.base, entry: initial.items[1] }));
  await flush();
  requests[0]!.resolve(Response.json({ base: initial.base, entry: initial.items[0] }));
  await flush();
  expect(dom.root.querySelector("h2")?.textContent).toBe("B.txt");
  expect(dom.window.location.search).toContain("file=B.txt");
  // The details panel names the place that holds the entry and keeps the technical location as tooltip.
  expect(dom.root.querySelector<HTMLElement>('[title="Home / B.txt"]')?.textContent).toBe("Personal");
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Grid"))!.click();
  await flush();
  expect(dom.root.querySelector('.k2b-file-grid__item[aria-selected="true"]')?.textContent).toContain("B.txt");
  expect(requests).toHaveLength(2);
  // A new page never writes its old selected path into the new URL.
  setDirectory({ ...initial, path: "A", items: [] });
  setSource("/app/filesv2?base=home&path=A");
  await flush();
  expect(dom.root.querySelector("h2")?.textContent).not.toBe("B.txt");
  expect(dom.root.textContent).toContain("This folder is empty");
});

test("favorite action is beside primary actions, suppresses duplicate requests and cannot leak across bases", async () => {
  const dom = createDomTestHarness();
  const { default: FileInspector } = await import("../src/frontend/FileInspector");
  const [base, setBase] = createSignal(initial.base);
  const entry = initial.items[0]!;
  const noop = () => {};
  const dispose = render(
    () => (
      <FileInspector
        base={base()}
        cloudUrl="https://cloud.test"
        selected={[entry]}
        paths={[entry.path]}
        initial={{ base: initial.base, entry, favorite: false }}
        onClose={noop}
        onOpen={noop}
        onDownload={noop}
        onRename={noop}
        onDuplicate={noop}
        onMove={noop}
        onCopy={noop}
        onTrash={noop}
        onChanged={noop}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  const button = () => dom.root.querySelector<HTMLButtonElement>(".filesv2-favorite")!;
  expect(button().getAttribute("aria-pressed")).toBe("false");
  const bar = () => [...button().closest(".filesv2-inspector-actions")!.querySelectorAll("button:not([role='menuitem'])")];
  expect(bar().map((action) => action.getAttribute("aria-label") ?? action.textContent?.trim())).toEqual([
    "Preview",
    "Download",
    "Add to favorites",
    "Actions",
  ]);
  button().click();
  button().click();
  await flush();
  expect(favoriteRequests).toHaveLength(1);
  expect(button().disabled).toBe(true);
  setBase({ ...initial.base, id: "other-home" });
  await flush();
  requests[0]!.resolve(Response.json({ base: base(), entry, favorite: false }));
  favoriteRequests[0]!.resolve(Response.json({ favorite: true }));
  await flush();
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(button().getAttribute("data-favorite")).toBeNull();
  button().click();
  await flush();
  favoriteRequests[1]!.resolve(Response.json({ favorite: true }));
  await flush();
  expect(button().getAttribute("aria-pressed")).toBe("true");
  expect(button().querySelector(".ti-star")).not.toBeNull();
  expect(button().querySelector(".ti-star-filled")).toBeNull();
  expect(button().querySelector(".ti-x")).not.toBeNull();
  expect(button().getAttribute("aria-label")).toBe("Remove from favorites");
  button().click();
  await flush();
  favoriteRequests[2]!.resolve(Response.json({ code: "unavailable", message: "Offline" }, { status: 503 }));
  await flush();
  expect(button().getAttribute("aria-pressed")).toBe("true");
});

test("details keep every action: a compact bar, the rest in one menu with the same permissions and busy state", async () => {
  const dom = createDomTestHarness();
  const { default: FileInspector } = await import("../src/frontend/FileInspector");
  const calls: string[] = [];
  const noop = () => {};
  const record = (name: string) => () => void calls.push(name);
  const [busy, setBusy] = createSignal(false);
  const show = (entry: FileEntry) =>
    render(
      () => (
        <FileInspector
          base={initial.base}
          cloudUrl="https://cloud.test"
          selected={[entry]}
          paths={[entry.path]}
          initial={{ base: initial.base, entry, favorite: false }}
          busy={busy()}
          onClose={noop}
          onOpen={record("open")}
          onPreview={noop}
          onDownload={record("download")}
          onRename={record("rename")}
          onDuplicate={record("duplicate")}
          onMove={record("move")}
          onCopy={record("copy")}
          onTrash={record("trash")}
          onShare={record("share")}
          onShareInbox={record("inbox")}
          onChanged={noop}
        />
      ),
      dom.root,
    );
  let dispose = show({ ...initial.items[0]!, actions: { write: true, move: true, share: true } });
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  const bar = () =>
    [...dom.root.querySelectorAll<HTMLButtonElement>(".filesv2-inspector-actions button:not([role='menuitem'])")].map(
      (action) => action.getAttribute("aria-label") ?? action.textContent?.trim(),
    );
  const menu = () => [...dom.root.querySelectorAll<HTMLButtonElement>(".filesv2-inspector-menu [role='menuitem']")];
  const item = (label: string) => menu().find((action) => action.textContent?.trim() === label)!;
  expect(bar()).toEqual(["Preview", "Download", "Share publicly", "Add to favorites", "Actions"]);
  expect(menu().map((action) => action.textContent?.trim())).toEqual([
    "Open in new tab",
    "Rename",
    "Duplicate",
    "Move to…",
    "Copy to…",
    "Copy Cloud reference",
    "Move to trash",
  ]);
  // The long list no longer pushes versions and history down.
  expect(dom.root.querySelector(".k2b-detail-panel__body .k2b-detail-panel__action")).toBeNull();
  // The approved order: identity, preview, the bar, then Info; the header keeps only identity and close.
  const lead = dom.root.querySelector(".filesv2-inspector-lead")!;
  expect([...lead.children].map((child) => child.className)).toEqual(["filesv2-inspector-preview", "filesv2-inspector-actions"]);
  expect(lead.nextElementSibling?.classList.contains("filesv2-inspector-info")).toBe(true);
  expect(dom.root.querySelector(".k2b-detail-panel__header .filesv2-favorite")).toBeNull();
  // Phones keep only the change date and the version count; this storage keeps no versions, which Info says.
  const only = (form: string) =>
    [...dom.root.querySelectorAll(`.filesv2-inspector-info [data-inspector-only="${form}"]`)].map(
      (value) => value.closest(".k2b-description-list__item")?.querySelector("dt")?.textContent,
    );
  expect(only("desktop")).toEqual(["Location", "Size"]);
  expect(only("phone")).toEqual(["Versions"]);
  expect(dom.root.querySelector('.filesv2-inspector-info [data-inspector-only="phone"]')?.textContent).toBe(
    "Versions are not enabled for this storage.",
  );
  for (const label of ["Rename", "Duplicate", "Move to…", "Copy to…", "Move to trash"]) item(label).click();
  expect(calls).toEqual(["rename", "duplicate", "move", "copy", "trash"]);

  // While another action runs, the bar and every changing menu action wait.
  setBusy(true);
  await flush();
  expect(
    [...dom.root.querySelectorAll<HTMLButtonElement>(".filesv2-inspector-actions button:not([role='menuitem'])")]
      .filter((action) => action.disabled)
      .map((action) => action.getAttribute("aria-label") ?? action.textContent?.trim()),
  ).toEqual(["Preview", "Download", "Share publicly", "Add to favorites"]);
  expect(
    menu()
      .filter((action) => !action.disabled)
      .map((action) => action.textContent?.trim()),
  ).toEqual(["Copy Cloud reference"]);
  setBusy(false);

  // Without move or share rights, those actions stay visible but disabled or leave, as before; a writable folder offers its inbox.
  dispose();
  dispose = show({
    name: "Docs",
    path: "Docs",
    directory: true,
    size: 0,
    modified: "2026-09-18T00:00:00Z",
    actions: { write: true, move: false, share: false },
  });
  await flush();
  expect(bar()).toEqual(["Open", "Download", "Add to favorites", "Actions"]);
  // A folder starts with the bar, has no versions, and phones hide its Info.
  expect([...dom.root.querySelector(".filesv2-inspector-lead")!.children].map((child) => child.className)).toEqual([
    "filesv2-inspector-actions",
  ]);
  expect(dom.root.querySelector(".filesv2-inspector-info")?.classList.contains("filesv2-inspector-info--folder")).toBe(true);
  expect(dom.root.querySelector(".filesv2-inspector-versions, [data-inspector-only='phone']")).toBeNull();
  expect(menu().map((action) => [action.textContent?.trim(), action.disabled])).toEqual([
    ["Rename", true],
    ["Duplicate", false],
    ["Move to…", true],
    ["Copy to…", false],
    ["Share as upload inbox", false],
    ["Copy Cloud reference", false],
    ["Move to trash", true],
  ]);
  item("Share as upload inbox").click();
  expect(calls.at(-1)).toBe("inbox");
});

test("tree branches cannot cross full cloud base identities or accept a superseded branch response", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const folder = { name: "Docs", path: "Docs", directory: true, size: 0, modified: "2026-01-01T00:00:00Z" };
  const first = { ...initial, base: { ...initial.base, id: "cloud:groups:first" }, items: [folder] };
  const [directory, setDirectory] = createSignal(first);
  const dispose = render(
    () => <Browser directory={directory()} bases={[directory().base]} cloudUrl="https://cloud.test" onNavigate={async () => {}} />,
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Tree"))!.click();
  await flush();
  dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
  await flush();
  expect(branchRequests).toHaveLength(1);
  setDirectory({ ...first, base: { ...first.base, id: "cloud:groups:second" } });
  await flush();
  expect(branchRequests[0]!.signal.aborted).toBe(true);
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Tree"))!.click();
  await flush();
  dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
  await flush();
  expect(branchRequests.length).toBeGreaterThanOrEqual(2);
  const current = branchRequests.at(-1)!;
  current.resolve(
    Response.json({ ...directory(), path: "Docs", items: [{ ...folder, name: "Current", path: "Docs/Current" }], next: null }),
  );
  await flush();
  branchRequests[0]!.resolve(
    Response.json({ ...first, path: "Docs", items: [{ ...folder, name: "Old private file", path: "Docs/Old" }], next: null }),
  );
  await flush();
  expect(dom.root.textContent).toContain("Current");
  expect(dom.root.textContent).not.toContain("Old private file");
  setDirectory({ ...directory(), base: { ...directory().base, locationKey: "rebound-root" } });
  await flush();
  expect(dom.root.textContent).not.toContain("Current");
  dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
  await flush();
  expect(branchRequests.at(-1)).not.toBe(current);
});

test("tree navigation keeps loaded ancestors and current files through folder changes and refreshes", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const folders = ["Bilder", "Finanzen"].map((name) => ({ name, path: name, directory: true, size: 0, modified: "2026-01-01T00:00:00Z" }));
  const root = { ...initial, items: folders };
  const [directory, setDirectory] = createSignal<DirectoryResult>(root);
  const dispose = render(
    () => (
      <Browser
        directory={directory()}
        bases={[initial.base]}
        cloudUrl="https://cloud.test"
        source={`/app/filesv2?base=home&path=${directory().path}`}
        onNavigate={async () => {}}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Tree"))!.click();
  await flush();
  const names = () => [...dom.root.querySelectorAll(".filesv2-list__name")].map((node) => node.textContent);
  for (const path of ["Bilder", "Finanzen", "Bilder"]) {
    setDirectory({ ...initial, path, items: [{ ...initial.items[0]!, name: `${path}.txt`, path: `${path}/${path}.txt` }] });
    await flush();
    expect(names()).toContain("Bilder");
    expect(names()).toContain("Finanzen");
    expect(names()).toContain(`${path}.txt`);
    expect(branchRequests).toHaveLength(0);
  }
  setDirectory({ ...directory(), items: [{ ...initial.items[0]!, name: "External.txt", path: "Bilder/External.txt" }] });
  await flush();
  expect(names()).toContain("External.txt");
  expect(names()).not.toContain("Bilder.txt");
  expect(names()).toContain("Finanzen.txt");
});

test("a slow or failed tree root never hides the loaded folder and can be retried", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const current = { ...initial, path: "Bilder", items: [{ ...initial.items[0]!, path: "Bilder/A.txt" }] };
  const dispose = render(
    () => <Browser directory={current} bases={[initial.base]} cloudUrl="https://cloud.test" onNavigate={async () => {}} />,
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Tree"))!.click();
  await flush();
  expect(dom.root.querySelector(".filesv2-list__name")?.textContent).toBe("A.txt");
  expect(dom.root.textContent).toContain("Loading files");
  branchRequests[0]!.resolve(Response.json({ code: "unavailable", message: "Offline" }, { status: 503 }));
  await flush();
  expect(dom.root.textContent).toContain("The folder tree could not be loaded");
  expect(dom.root.querySelector(".filesv2-list__name")?.textContent).toBe("A.txt");
  [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Try again")!.click();
  await flush();
  // The current folder can also be absent from a filtered or paginated root page.
  branchRequests[1]!.resolve(Response.json({ ...initial, items: [], next: "root-page-2" }));
  await flush();
  expect(dom.root.querySelector(".filesv2-list__name")?.textContent).toBe("A.txt");
  expect(dom.root.textContent).not.toContain("Loading files");
  expect(dom.root.textContent).not.toContain("The folder tree could not be loaded");
});

test("tree query changes reject late ancestor replies and navigation supersedes a pending child", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const folder = { name: "Bilder", path: "Bilder", directory: true, size: 0, modified: "2026-01-01T00:00:00Z" };
  const current = { ...initial, path: "Bilder", items: [{ ...initial.items[0]!, path: "Bilder/A.txt" }] };
  const [directory, setDirectory] = createSignal<DirectoryResult>(current);
  const [source, setSource] = createSignal("/app/filesv2?base=home&path=Bilder&sort=name");
  const dispose = render(
    () => (
      <Browser directory={directory()} source={source()} bases={[initial.base]} cloudUrl="https://cloud.test" onNavigate={async () => {}} />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Tree"))!.click();
  await flush();
  const old = branchRequests[0]!;
  setSource("/app/filesv2?base=home&path=Bilder&sort=modified&order=desc");
  await flush();
  expect(old.signal.aborted).toBe(true);
  const fresh = branchRequests.at(-1)!;
  fresh.resolve(Response.json({ ...initial, items: [folder] }));
  await flush();
  old.resolve(Response.json({ ...initial, items: [{ ...folder, name: "Stale root", path: "stale" }] }));
  await flush();
  expect(dom.root.textContent).not.toContain("Stale root");
  expect(dom.root.querySelectorAll(".filesv2-list__row")).toHaveLength(2);
  const other = { ...folder, name: "Finanzen", path: "Finanzen" };
  setDirectory({ ...initial, items: [folder, other] });
  await flush();
  const row = [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find(
    (node) => node.querySelector(".filesv2-list__name")?.textContent === "Finanzen",
  )!;
  row.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
  await flush();
  const child = branchRequests.at(-1)!;
  setDirectory({ ...initial, path: "Finanzen", items: [{ ...initial.items[0]!, name: "Latest.txt", path: "Finanzen/Latest.txt" }] });
  await flush();
  expect(child.signal.aborted).toBe(true);
  child.resolve(Response.json({ ...initial, path: "Finanzen", items: [] }));
  await flush();
  expect(dom.root.textContent).toContain("Latest.txt");
});

test("list and tree mark their active row with one class; checked rows in select mode are selected, not active", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const folder = (path: string) => ({ name: path.split("/").at(-1)!, path, directory: true, size: 0, modified: "2026-01-01T00:00:00Z" });
  const current: DirectoryResult = {
    ...initial,
    path: "Projects",
    items: [folder("Projects/Drafts"), { ...initial.items[0]!, name: "Notes.md", path: "Projects/Notes.md" }],
  };
  const dispose = render(
    () => (
      <Browser
        directory={current}
        bases={[initial.base]}
        cloudUrl="https://cloud.test"
        source="/app/filesv2?base=home&path=Projects"
        onNavigate={async () => {}}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  const row = (name: string) =>
    [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find(
      (node) => node.querySelector(".filesv2-list__name")?.textContent === name,
    )!;
  const active = () => [...dom.root.querySelectorAll(".filesv2-list__row--active .filesv2-list__name")].map((node) => node.textContent);
  const icon = (name: string) => row(name).querySelector(".filesv2-list__cell--icon i")!.classList;
  const button = (text: string) =>
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text)!;
  expect(active()).toEqual([]);
  expect(icon("Drafts").contains("ti-folder")).toBeTrue();

  // List: the entry whose details are open is the active row; a folder opens its icon like the tree's current folder.
  row("Notes.md").click();
  await flush();
  expect(active()).toEqual(["Notes.md"]);
  row("Drafts").querySelector<HTMLButtonElement>('[aria-label="Details: Drafts"]')!.click();
  await flush();
  expect(active()).toEqual(["Drafts"]);
  expect(row("Drafts").getAttribute("aria-selected")).toBe("true");
  expect(icon("Drafts").contains("ti-folder-open")).toBeTrue();

  // Select mode: checked rows stay selected for assistive technology and the fill, but none is active.
  button("Select").click();
  await flush();
  row("Notes.md").click();
  await flush();
  expect(dom.root.querySelector('[role="grid"]')?.getAttribute("data-selecting")).toBe("true");
  expect(row("Notes.md").getAttribute("aria-selected")).toBe("true");
  expect(active()).toEqual([]);
  expect(icon("Drafts").contains("ti-folder-open")).toBeFalse();
  button("Done").click();
  await flush();

  // Tree: the current folder carries the same class next to its location marker.
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((node) => node.textContent?.includes("Tree"))!.click();
  await flush();
  branchRequests[0]!.resolve(Response.json({ ...initial, items: [folder("Archive"), folder("Projects")] }));
  await flush();
  expect(active()).toEqual(["Projects"]);
  expect(row("Projects").getAttribute("aria-current")).toBe("location");
  expect(icon("Projects").contains("ti-folder-open")).toBeTrue();
  expect(row("Archive").classList.contains("filesv2-list__row--active")).toBeFalse();
});

test("outside select mode Shift+Arrow moves the one active row; in select mode it still extends the range", async () => {
  const dom = createDomTestHarness();
  const Browser = await browserWithUploads();
  const items = ["A.txt", "B.txt", "C.txt"].map((name) => ({ ...initial.items[0]!, name, path: name }));
  const dispose = render(
    () => (
      <Browser
        directory={{ ...initial, items }}
        bases={[initial.base]}
        cloudUrl="https://cloud.test"
        source="/app/filesv2?base=home"
        onNavigate={async () => {}}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  const row = (name: string) =>
    [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find(
      (node) => node.querySelector(".filesv2-list__name")?.textContent === name,
    )!;
  const names = (selector: string) => [...dom.root.querySelectorAll(`${selector} .filesv2-list__name`)].map((node) => node.textContent);
  const shiftDown = (name: string) => {
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true });
    row(name).dispatchEvent(event);
    return event;
  };

  row("A.txt").click();
  await flush();
  expect(shiftDown("A.txt").defaultPrevented).toBeTrue();
  await flush();
  shiftDown("B.txt");
  await flush();
  expect(names(".filesv2-list__row--active")).toEqual(["C.txt"]);
  expect(names('.filesv2-list__row[aria-selected="true"]')).toEqual(["C.txt"]);

  [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Select")!.click();
  await flush();
  row("A.txt").click();
  await flush();
  shiftDown("A.txt");
  await flush();
  expect(names('.filesv2-list__row[aria-selected="true"]')).toEqual(["A.txt", "B.txt"]);
  expect(names(".filesv2-list__row--active")).toEqual([]);
});
