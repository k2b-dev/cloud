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
        entries: { $get: (input: unknown, options: { init: { signal: AbortSignal } }) => new Promise<Response>(resolve => branchRequests.push({ input, signal: options.init.signal, resolve })) },
        favorite: { $post: (input: unknown) => new Promise<Response>(resolve => favoriteRequests.push({ input, resolve })) },
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
  const dispose = render(() => <Browser directory={directory()} bases={[initial.base]} cloudUrl="https://cloud.test" source={source()} onNavigate={async () => {}} />, dom.root);
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
  const dispose = render(() => <FileInspector base={base()} cloudUrl="https://cloud.test" selected={[entry]} paths={[entry.path]}
    initial={{ base: initial.base, entry, favorite: false }} onClose={noop} onOpen={noop} onDownload={noop} onRename={noop}
    onDuplicate={noop} onMove={noop} onCopy={noop} onTrash={noop} onChanged={noop} />, dom.root);
  cleanup = () => { dispose(); dom.cleanup(); };
  await flush();
  const button = () => dom.root.querySelector<HTMLButtonElement>(".filesv2-favorite")!;
  expect(button().getAttribute("aria-pressed")).toBe("false");
  expect(button().parentElement?.parentElement?.textContent).toContain("Download");
  button().click(); button().click();
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
  const dispose = render(() => <Browser directory={directory()} bases={[directory().base]} cloudUrl="https://cloud.test" onNavigate={async () => {}} />, dom.root);
  cleanup = () => { dispose(); dom.cleanup(); };
  await flush();
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.includes("Tree"))!.click();
  await flush();
  dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
  await flush();
  expect(branchRequests).toHaveLength(1);
  setDirectory({ ...first, base: { ...first.base, id: "cloud:groups:second" } });
  await flush();
  expect(branchRequests[0]!.signal.aborted).toBe(true);
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(button => button.textContent?.includes("Tree"))!.click();
  await flush();
  dom.root.querySelector<HTMLButtonElement>(".filesv2-list__disclosure")!.click();
  await flush();
  expect(branchRequests.length).toBeGreaterThanOrEqual(2);
  const current = branchRequests.at(-1)!;
  current.resolve(Response.json({ ...directory(), path: "Docs", items: [{ ...folder, name: "Current", path: "Docs/Current" }], next: null }));
  await flush();
  branchRequests[0]!.resolve(Response.json({ ...first, path: "Docs", items: [{ ...folder, name: "Old private file", path: "Docs/Old" }], next: null }));
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
