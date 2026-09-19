import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult } from "../src/contracts";

const requests: Array<{ kind: string; input: unknown; resolve: (response: Response) => void }> = [];
if (!isServer) {
  const request = (kind: string) => (input: unknown) => new Promise<Response>((resolve) => requests.push({ kind, input: structuredClone(input), resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        ":baseId": {
          move: { $post: request("move") },
          entry: { $get: async (input: { query: { path: string } }) => Response.json({ base: directory.base, entry: directory.items.find((item) => item.path === input.query.path) }) },
        },
      },
    },
  }));
}
const flush = async () => {
  for (let index = 0; index < 16; index++) await Promise.resolve();
};
const directory: DirectoryResult = {
  base: { id: "cloud:groups:demo", area: "cloud", kind: "groups", name: "Demo", status: "existing", reason: null, indexEnabled: true, versioningEnabled: true },
  path: "Docs",
  items: [
    { name: "zebra.txt", path: "Docs/zebra.txt", directory: false, size: 10, modified: "2026-09-19T10:00:00Z" },
    { name: "Archive", path: "Docs/Archive", directory: true, size: 0, modified: "2026-09-18T10:00:00Z" },
    { name: "alpha.png", path: "Docs/alpha.png", directory: false, size: 5000, modified: "2026-09-17T10:00:00Z" },
  ],
  next: null,
};

describe("Files v2 ordering and drag-and-drop", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
  });
  const mount = async (dom: ReturnType<typeof createDomTestHarness>, changed: string[]) => {
    const { default: Browser } = await import("../src/frontend/Browser");
    const dispose = render(
      () => createComponent(Browser, { directory, bases: [directory.base], cloudUrl: "https://cloud.test", onNavigate: async () => {}, onChanged: () => changed.push("changed") }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
  };
  const names = (dom: ReturnType<typeof createDomTestHarness>) =>
    [...dom.root.querySelectorAll(".filesv2-list__row:not(.filesv2-list__row--virtual) .filesv2-list__name")].map((node) => node.textContent?.trim());

  test("folders stay first, headers toggle the order and the type filter narrows the page", async () => {
    const dom = createDomTestHarness();
    await mount(dom, []);
    expect(names(dom)).toEqual(["Archive", "alpha.png", "zebra.txt"]);
    const header = (label: string) => [...dom.root.querySelectorAll<HTMLButtonElement>(".filesv2-list__sort")].find((node) => node.textContent?.includes(label))!;
    header("Name").click();
    await flush();
    expect(names(dom)).toEqual(["Archive", "zebra.txt", "alpha.png"]);
    header("Size").click();
    await flush();
    expect(names(dom)).toEqual(["Archive", "zebra.txt", "alpha.png"]);
    header("Size").click();
    await flush();
    expect(names(dom)).toEqual(["Archive", "alpha.png", "zebra.txt"]);
    expect(dom.root.querySelector('[aria-sort="descending"]')?.textContent).toContain("Size");
    const chip = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith("Type:"))!;
    chip.click();
    await flush();
    [...dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="option"], button')].find((node) => node.textContent?.trim() === "Images")!.click();
    await flush();
    expect(names(dom)).toEqual(["alpha.png"]);
  });

  test("dropping a dragged entry on a folder moves it and the parent row accepts drops too", async () => {
    const dom = createDomTestHarness();
    const changed: string[] = [];
    await mount(dom, changed);
    const row = (text: string) => [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find((node) => node.textContent?.includes(text))!;
    const transfer = { data: new Map<string, string>(), effectAllowed: "", dropEffect: "", setData: (type: string, value: string) => transfer.data.set(type, value), setDragImage: () => {} };
    const drag = (target: HTMLElement, type: string) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      target.dispatchEvent(event);
      return event;
    };
    drag(row("zebra.txt"), "dragstart");
    await flush();
    expect(row("zebra.txt").getAttribute("data-dragging")).toBe("true");
    expect(drag(row("alpha.png"), "dragover").defaultPrevented).toBe(false);
    expect(drag(row("Archive"), "dragover").defaultPrevented).toBe(true);
    await flush();
    expect(row("Archive").getAttribute("data-drop-target")).toBe("true");
    drag(row("Archive"), "drop");
    await flush();
    expect(requests.map((request) => request.kind)).toEqual(["move"]);
    expect(requests[0]!.input).toEqual({ param: { baseId: directory.base.id }, json: { paths: ["Docs/zebra.txt"], folder: "Docs/Archive" } });
    requests[0]!.resolve(Response.json({ base: directory.base, entries: [] }));
    await flush();
    expect(changed).toEqual(["changed"]);
    // The ".." row moves entries to the parent folder.
    drag(row("alpha.png"), "dragstart");
    await flush();
    const up = dom.root.querySelector<HTMLElement>(".filesv2-list__row--up")!;
    expect(drag(up, "dragover").defaultPrevented).toBe(true);
    drag(up, "drop");
    await flush();
    expect(requests[1]!.input).toEqual({ param: { baseId: directory.base.id }, json: { paths: ["Docs/alpha.png"], folder: "" } });
  });
});
