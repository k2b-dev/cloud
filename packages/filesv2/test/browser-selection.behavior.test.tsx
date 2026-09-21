import { afterEach, expect, mock, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult } from "../src/contracts";

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
  const { default: Browser } = await import("../src/frontend/Browser");
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
  // The details panel labels the personal base and keeps the technical location as tooltip.
  expect(dom.root.querySelector<HTMLElement>('[title="Home / B.txt"]')?.textContent).toBe("My files / B.txt");
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
  expect(button().parentElement?.parentElement?.textContent).toContain("Download");
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

test("tree branches cannot cross full cloud base identities or accept a superseded branch response", async () => {
  const dom = createDomTestHarness();
  const { default: Browser } = await import("../src/frontend/Browser");
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
  const { default: Browser } = await import("../src/frontend/Browser");
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
  const { default: Browser } = await import("../src/frontend/Browser");
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
  const { default: Browser } = await import("../src/frontend/Browser");
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
