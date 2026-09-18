import { afterEach, expect, mock, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult } from "../src/contracts";

const requests: Array<{ signal: AbortSignal; input: unknown; resolve: (response: Response) => void }> = [];
mock.module("../src/api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": {
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
  items: ["A", "B"].map((name) => ({ name, path: name, directory: true, size: 0, modified: "2026-09-18T00:00:00Z" })),
  next: null,
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  requests.length = 0;
});

test("view changes preserve selection; superseded details cannot replace current content; navigation clears selection", async () => {
  const dom = createDomTestHarness();
  const { default: Browser } = await import("../src/frontend/Browser");
  const [directory, setDirectory] = createSignal(initial);
  const [source, setSource] = createSignal("/app/filesv2?base=home");
  const dispose = render(() => <Browser directory={directory()} source={source()} onNavigate={async () => {}} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  await flush();
  expect(requests).toHaveLength(0);
  const rows = [...dom.root.querySelectorAll<HTMLTableRowElement>("tbody tr")];
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
  expect(dom.root.querySelector("h2")?.textContent).toBe("B");
  expect(dom.window.location.search).toContain("file=B");
  [...dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes("Grid"))!.click();
  await flush();
  expect(dom.root.querySelector('[role="gridcell"][aria-selected="true"]')?.textContent).toContain("B");
  expect(requests).toHaveLength(2);
  // A new page never writes its old selected path into the new URL.
  setDirectory({ ...initial, path: "A", items: [] });
  setSource("/app/filesv2?base=home&path=A");
  await flush();
  expect(dom.root.querySelector("h2")?.textContent).not.toBe("B");
  expect(dom.root.textContent).toContain("This folder is empty");
});
