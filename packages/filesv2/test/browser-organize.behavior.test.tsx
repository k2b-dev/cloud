import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ContextAwareCommand } from "@k2b/cloud/browser/commands";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { BrowseOptions, DirectoryResult } from "../src/contracts";
import { browserWithUploads } from "./browser-with-uploads";

const browseChanges: BrowseOptions[] = [];
const requests: Array<{ kind: string; input: unknown; resolve: (response: Response) => void }> = [];
if (!isServer) {
  const request = (kind: string) => (input: unknown) =>
    new Promise<Response>((resolve) => requests.push({ kind, input: structuredClone(input), resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        ":baseId": {
          move: { $post: request("move") },
          entry: {
            $get: async (input: { query: { path: string } }) =>
              Response.json({ base: directory.base, entry: directory.items.find((item) => item.path === input.query.path) }),
          },
        },
      },
    },
  }));
}
const flush = async () => {
  for (let index = 0; index < 16; index++) await Promise.resolve();
};
const directory: DirectoryResult = {
  base: {
    id: "cloud:groups:demo",
    area: "cloud",
    kind: "groups",
    name: "Demo",
    status: "existing",
    reason: null,
    indexEnabled: true,
    versioningEnabled: true,
  },
  path: "Docs",
  items: [
    { name: "zebra.txt", path: "Docs/zebra.txt", directory: false, size: 10, modified: "2026-09-19T10:00:00Z" },
    { name: "Archive", path: "Docs/Archive", directory: true, size: 0, modified: "2026-09-18T10:00:00Z" },
    { name: "alpha.png", path: "Docs/alpha.png", directory: false, size: 5000, modified: "2026-09-17T10:00:00Z" },
  ],
  next: null,
};

describe("Filesv2 ordering and drag-and-drop", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
    browseChanges.length = 0;
  });
  const mount = async (
    dom: ReturnType<typeof createDomTestHarness>,
    changed: string[],
    options: { directory?: DirectoryResult; onOpenDirectory?: (path: string) => void; onOpenOverview?: () => void } = {},
  ) => {
    const listing = options.directory ?? directory;
    const Browser = await browserWithUploads();
    const [source, setSource] = createSignal(
      `/app/filesv2?base=${encodeURIComponent(listing.base.id)}&path=${encodeURIComponent(listing.path)}`,
    );
    const dispose = render(
      () =>
        createComponent(Browser, {
          directory: listing,
          onOpenDirectory: options.onOpenDirectory,
          onOpenOverview: options.onOpenOverview,
          get source() {
            return source();
          },
          onBrowseChange: (options: BrowseOptions) => {
            browseChanges.push(options);
            const query = new URLSearchParams({ base: directory.base.id, path: directory.path });
            for (const [key, value] of Object.entries(options)) query.set(key, String(value));
            setSource(`/app/filesv2?${query}`);
          },
          bases: [directory.base],
          cloudUrl: "https://cloud.test",
          onNavigate: async () => {},
          onChanged: () => changed.push("changed"),
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
  };
  const names = (dom: ReturnType<typeof createDomTestHarness>) =>
    [...dom.root.querySelectorAll(".filesv2-list__row:not(.filesv2-list__row--virtual) .filesv2-list__name")].map((node) =>
      node.textContent?.trim(),
    );

  for (const [lang, path, detail, label] of [
    ["en", "", null, "Parent folder"],
    ["en", "A", "Personal", "Parent folder"],
    ["en", "A/B/C", "B", "Parent folder"],
    ["de", "A/B/C", "B", "Übergeordneter Ordner"],
  ] as const) {
    test(`${lang} parent row at ${path || "storage root"} names its destination and stays outside bulk selection`, async () => {
      const dom = createDomTestHarness();
      dom.document.documentElement.lang = lang;
      const opened: string[] = [];
      const listing = { ...directory, base: { ...directory.base, kind: "users" as const }, path };
      await mount(dom, [], { directory: listing, onOpenDirectory: (path) => opened.push(path) });
      const up = dom.root.querySelector<HTMLElement>(".filesv2-list__row--up");
      if (detail === null) {
        expect(up).toBeNull();
        return;
      }
      expect(dom.root.querySelector(".filesv2-list__row")).toBe(up);
      expect(up!.querySelector(".filesv2-list__name")!.textContent).toBe(label);
      expect(up!.querySelector(".filesv2-list__detail")!.textContent).toBe(detail);
      expect(up!.getAttribute("aria-label")).toBe(
        lang === "de" ? `Zum übergeordneten Ordner „${detail}“` : `Up to the parent folder “${detail}”`,
      );
      expect(up!.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Backspace");
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.trim() === (lang === "de" ? "Auswählen" : "Select"))!
        .click();
      await flush();
      expect(up!.querySelector('input[type="checkbox"], [role="checkbox"]')).toBeNull();
      const entries = [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row:not(.filesv2-list__row--virtual)")];
      expect(entries).toHaveLength(listing.items.length);
      entries[0]!.focus();
      entries[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
      await flush();
      expect(entries.every((row) => row.getAttribute("aria-selected") === "true")).toBe(true);
      expect(up!.hasAttribute("aria-selected")).toBe(false);
      expect(dom.root.textContent).toContain(lang === "de" ? "3 ausgewählt" : "3 selected");
      // Dragging a selected entry carries exactly the real entries, never the virtual parent.
      let payload = "";
      const drag = new dom.window.Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(drag, "dataTransfer", {
        value: {
          setData: (_type: string, value: string) => {
            payload = value;
          },
          setDragImage: () => {},
        },
      });
      entries[0]!.dispatchEvent(drag);
      expect(JSON.parse(payload).paths).toEqual(listing.items.map((item) => item.path));
      const parent = path.split("/").slice(0, -1).join("/");
      up!.click();
      await flush();
      expect(opened).toEqual([parent]);
      up!.focus();
      up!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flush();
      expect(opened).toEqual([parent, parent]);
    });
  }

  test("the root row, command and Backspace lead to all storage without a move target", async () => {
    const dom = createDomTestHarness();
    const opened: string[] = [];
    await mount(dom, [], { directory: { ...directory, path: "", items: [] }, onOpenOverview: () => opened.push("overview") });
    const up = dom.root.querySelector<HTMLElement>(".filesv2-list__row--up")!;
    expect(up).not.toBeNull();
    expect(up.querySelector(".filesv2-list__name")!.textContent).toBe("All storage");
    expect(up.querySelector(".filesv2-list__detail")).toBeNull();
    expect(up.getAttribute("aria-label")).toBe("Up to all storage");
    expect(up.querySelector(".ti-layout-grid")).not.toBeNull();
    expect(up.hasAttribute("data-drop-target")).toBe(false);
    up.dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true }));
    expect(requests).toHaveLength(0);
    up.click();
    await flush();
    expect(up.querySelector(".filesv2-list__cell--icon .ti-loader-2")).not.toBeNull();
    const commands: ContextAwareCommand[] = [];
    dom.window.dispatchEvent(new dom.window.CustomEvent("cloud.command.collect", { detail: { commands } }));
    const command = commands.find((entry) => entry.id === "filesv2.parent-folder")!;
    expect(command.title).toBe("All storage");
    expect(command.description).toBe("Up to all storage");
    expect(command.icon).toBe("ti ti-layout-grid");
    const { runContextAwareCommand } = await import("@k2b/cloud/browser/commands");
    await runContextAwareCommand(command);
    up.focus();
    up.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    await flush();
    expect(opened).toEqual(["overview", "overview", "overview"]);
  });

  for (const path of ["", "A/B/C"]) {
    test(`parent keyboard command and focused-list Backspace at ${path || "storage root"}`, async () => {
      const dom = createDomTestHarness();
      const opened: string[] = [];
      await mount(dom, [], { directory: { ...directory, path }, onOpenDirectory: (path) => opened.push(path) });
      // The public commands entry point exposes execution; collection uses the same cross-island event as the palette.
      const commands: ContextAwareCommand[] = [];
      dom.window.dispatchEvent(new dom.window.CustomEvent("cloud.command.collect", { detail: { commands } }));
      const command = commands.find((entry) => entry.id === "filesv2.parent-folder");
      if (!path) {
        expect(command).toBeUndefined();
      } else {
        expect(command).toBeDefined();
        expect(command!.shortcut).toBe("alt+arrowup");
        const { runContextAwareCommand } = await import("@k2b/cloud/browser/commands");
        await runContextAwareCommand(command!);
        await flush();
        expect(opened).toEqual(["A/B"]);
      }
      const row = dom.root.querySelector<HTMLElement>(".filesv2-list__row:not(.filesv2-list__row--virtual)")!;
      row.focus();
      const backspace = () => new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
      const listKey = backspace();
      row.dispatchEvent(listKey);
      await flush();
      expect(listKey.defaultPrevented).toBe(!!path);
      expect(opened).toEqual(path ? ["A/B", "A/B"] : []);
      const search = dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.focus();
      search.value = "report";
      const typing = backspace();
      search.dispatchEvent(typing);
      await flush();
      expect(typing.defaultPrevented).toBe(false);
      expect(opened).toEqual(path ? ["A/B", "A/B"] : []);
    });
  }

  test("headers and type filter request global ordering and never locally reorder a server page", async () => {
    const dom = createDomTestHarness();
    await mount(dom, []);
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    const header = (label: string) =>
      [...dom.root.querySelectorAll<HTMLButtonElement>(".filesv2-list__sort")].find((node) => node.textContent?.includes(label))!;
    header("Name").click();
    await flush();
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    header("Size").click();
    await flush();
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    header("Size").click();
    await flush();
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    expect(browseChanges).toEqual([
      { sort: "name", order: "desc", type: "all", groupFolders: true },
      { sort: "size", order: "asc", type: "all", groupFolders: true },
      { sort: "size", order: "desc", type: "all", groupFolders: true },
    ]);
    expect(dom.root.querySelector('[aria-sort="descending"]')?.textContent).toContain("Size");
    const chip = [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.getAttribute("aria-label") === "Sort and filter",
    )!;
    chip.click();
    await flush();
    [...dom.document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="option"], button')]
      .find((node) => node.textContent?.trim() === "Files")!
      .click();
    await flush();
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    expect(browseChanges.at(-1)?.type).toBe("files");
  });

  test("one input button beside search controls all three sections and resets to folders first", async () => {
    const dom = createDomTestHarness();
    await mount(dom, []);
    const button = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Sort and filter"]')!;
    expect(button.getAttribute("data-variant")).toBe("input");
    expect(button.classList.contains("k2b-icon-button")).toBe(true);
    expect(button.closest(".filesv2-browser__header")?.querySelector('input[type="search"]')).not.toBeNull();
    expect(button.textContent?.trim()).toBe("");
    const firstRow = () => dom.root.querySelector(".filesv2-list__row .filesv2-list__name")?.textContent;
    expect(firstRow()).toBe("Parent folder");
    button.click();
    await flush();
    const menu = () => dom.document.querySelector<HTMLElement>('[role="menu"][aria-label="Sort and filter"]')!;
    expect(menu().textContent).toContain("Sort by");
    expect(menu().textContent).toContain("Order");
    expect(menu().textContent).toContain("Type");
    const choose = async (label: string) => {
      [...menu().querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"]')]
        .find((node) => node.textContent?.trim() === label)!
        .click();
      await flush();
    };
    await choose("Descending");
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    expect(firstRow()).toBe("Parent folder");
    await choose("Group folders");
    expect(browseChanges.at(-1)?.groupFolders).toBe(false);
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    expect(firstRow()).toBe("Parent folder");
    await choose("Group folders");
    await choose("Files");
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    expect(browseChanges.at(-1)?.type).toBe("files");
    expect(firstRow()).toBe("Parent folder");
    await choose("Size");
    const checked = () => [...menu().querySelectorAll('[aria-checked="true"]')].map((node) => node.textContent?.trim());
    expect(checked()).toEqual(["Size", "Descending", "Files", "Group folders"]);
    await choose("Reset");
    expect(names(dom)).toEqual(["zebra.txt", "Archive", "alpha.png"]);
    expect(checked()).toEqual(["Name", "Ascending", "All", "Group folders"]);
    expect(firstRow()).toBe("Parent folder");
  });

  test("dropping a dragged entry on a folder moves it and the parent row accepts drops too", async () => {
    const dom = createDomTestHarness();
    const changed: string[] = [];
    await mount(dom, changed);
    const row = (text: string) =>
      [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find((node) => node.textContent?.includes(text))!;
    const transfer = {
      data: new Map<string, string>(),
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, value: string) => transfer.data.set(type, value),
      setDragImage: () => {},
    };
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
    expect(requests[0]!.input).toEqual({
      param: { baseId: directory.base.id },
      json: { paths: ["Docs/zebra.txt"], folder: "Docs/Archive" },
    });
    requests[0]!.resolve(
      Response.json({ base: directory.base, entries: [], results: [{ path: "Docs/zebra.txt", ok: true, entry: directory.items[0] }] }),
    );
    await flush();
    expect(changed).toEqual(["changed"]);
    // The parent row moves entries to the parent folder.
    drag(row("alpha.png"), "dragstart");
    await flush();
    const up = dom.root.querySelector<HTMLElement>(".filesv2-list__row--up")!;
    expect(drag(up, "dragover").defaultPrevented).toBe(true);
    drag(up, "drop");
    await flush();
    expect(requests[1]!.input).toEqual({ param: { baseId: directory.base.id }, json: { paths: ["Docs/alpha.png"], folder: "" } });
  });
  test("a partial batch refreshes successes and retries only the failed selection", async () => {
    const dom = createDomTestHarness();
    const changed: string[] = [];
    await mount(dom, changed);
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Select")!.click();
    await flush();
    const row = (text: string) =>
      [...dom.root.querySelectorAll<HTMLElement>(".filesv2-list__row")].find((node) => node.textContent?.includes(text))!;
    row("zebra.txt").click();
    row("alpha.png").click();
    await flush();
    const transfer = { effectAllowed: "", dropEffect: "", setData: () => {}, setDragImage: () => {} };
    const drag = (target: HTMLElement, type: string) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      target.dispatchEvent(event);
    };
    drag(row("zebra.txt"), "dragstart");
    drag(row("Archive"), "drop");
    await flush();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(
      Response.json({
        base: directory.base,
        entries: [directory.items[0]],
        results: [
          { path: "Docs/zebra.txt", ok: true, entry: directory.items[0] },
          { path: "Docs/alpha.png", ok: false, error: "Access changed" },
        ],
      }),
    );
    await flush();
    expect(changed).toEqual(["changed"]);
    expect(row("alpha.png").getAttribute("aria-selected")).toBe("true");
    expect(row("zebra.txt").getAttribute("aria-selected")).toBe("false");
    drag(row("alpha.png"), "dragstart");
    drag(row("Archive"), "drop");
    await flush();
    expect(requests[1]!.input).toEqual({
      param: { baseId: directory.base.id },
      json: { paths: ["Docs/alpha.png"], folder: "Docs/Archive" },
    });
  });
});
