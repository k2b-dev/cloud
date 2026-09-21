import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult, EditorLaunch } from "../src/contracts";

const requests: Array<{ kind: string; input: unknown; resolve: (response: Response) => void }> = [];
if (!isServer) {
  const request = (kind: string) => (input: unknown) =>
    new Promise<Response>((resolve) => requests.push({ kind, input: structuredClone(input), resolve }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        ":baseId": {
          documents: { $post: request("documents") },
          thumbnail: { $post: request("thumbnail") },
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
  path: "",
  items: [
    { name: "Minutes.odt", path: "Minutes.odt", directory: false, size: 755, modified: "2026-09-19T10:00:00Z" },
    { name: "notes.txt", path: "notes.txt", directory: false, size: 4, modified: "2026-09-19T10:00:00Z" },
  ],
  next: null,
};
const launch: EditorLaunch = {
  base: directory.base,
  entry: directory.items[0]!,
  action: "http://localhost:9980/browser/abc/cool.html?WOPISrc=http%3A%2F%2Fgateway%3A3000%2Fapi%2Ffilesv2%2Fwopi%2Ffiles%2Fx",
  token: "body.signature",
  tokenTtl: 1_800_000_000_000,
  canWrite: true,
};

describe("Filesv2 office editing", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    requests.length = 0;
  });

  test("office files open in the editor and the plus menu creates documents only when Collabora is configured", async () => {
    const dom = createDomTestHarness();
    const { default: Browser } = await import("../src/frontend/Browser");
    const { dialogCore } = await import("@k2b/ui");
    const edited: string[] = [];
    const props = {
      directory,
      bases: [directory.base],
      cloudUrl: "https://cloud.test",
      onNavigate: async () => {},
      onEdit: (entry: { path: string }) => edited.push(entry.path),
    };
    let dispose = render(() => createComponent(Browser, { ...props, editor: null }), dom.root);
    cleanup = () => {
      dialogCore.close();
      dispose();
      dom.cleanup();
    };
    await flush();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click();
    await flush();
    expect(dom.document.body.textContent).not.toContain("New text document");
    dispose();
    dispose = render(() => createComponent(Browser, { ...props, editor: { documentFormat: "odf" } }), dom.root);
    await flush();
    const rows = dom.root.querySelectorAll('[role="row"].filesv2-list__row');
    expect(rows).toHaveLength(2);
    rows[1]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flush();
    expect(edited).toEqual([]);
    rows[0]!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await flush();
    expect(edited).toEqual(["Minutes.odt"]);
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click();
    await flush();
    const item = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
      node.textContent?.includes("New spreadsheet"),
    )!;
    item.click();
    await flush();
    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Name (.ods is added)");
    const name = dialog.querySelector<HTMLInputElement>("input")!;
    name.value = "Budget";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(requests.map((request) => request.kind)).toEqual(["documents"]);
    expect(requests[0]!.input).toEqual({ param: { baseId: directory.base.id }, json: { path: "Budget", kind: "spreadsheet" } });
    requests[0]!.resolve(
      Response.json({
        base: directory.base,
        entry: { name: "Budget.ods", path: "Budget.ods", directory: false, size: 808, modified: "2026-09-19T11:00:00Z" },
      }),
    );
    await flush();
    expect(edited).toEqual(["Minutes.odt", "Budget.ods"]);
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Add"]')!.click();
    await flush();
    [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((node) => node.textContent?.includes("New spreadsheet"))!
      .click();
    await flush();
    const delayedDialog = dom.document.querySelector("dialog")!;
    const delayedName = delayedDialog.querySelector<HTMLInputElement>("input")!;
    delayedName.value = "Delayed";
    delayedName.dispatchEvent(new Event("input", { bubbles: true }));
    delayedDialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    dispose(); // Leaving the browser must not let a late response navigate the new location.
    requests[1]!.resolve(
      Response.json({ base: directory.base, entry: { ...directory.items[0]!, name: "Delayed.ods", path: "Delayed.ods" } }),
    );
    await flush();
    expect(edited).toEqual(["Minutes.odt", "Budget.ods"]);
  });

  test("office and PDF thumbnails remain icons without network requests", async () => {
    const dom = createDomTestHarness();
    const { default: FileThumbnail } = await import("../src/frontend/FileThumbnail");
    const dispose = render(
      () => (
        <>
          <FileThumbnail baseId="test" entry={directory.items[0]!} large />
          <FileThumbnail baseId="test" entry={{ ...directory.items[0]!, name: "Report.pdf", path: "Report.pdf" }} large />
        </>
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await flush();
    expect(dom.root.querySelectorAll(".filesv2-thumbnail i")).toHaveLength(2);
    expect(dom.root.querySelectorAll("img")).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("the editor hands Collabora the token, asks for its close button and hides comments", async () => {
    const dom = createDomTestHarness();
    const submitted: string[] = [];
    const submit = dom.window.HTMLFormElement.prototype.submit;
    dom.window.HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      submitted.push(this.action);
    };
    const { default: Editor } = await import("../src/frontend/Editor");
    const backs: number[] = [];
    const dispose = render(() => createComponent(Editor, { launch, onBack: () => backs.push(1) }), dom.root);
    cleanup = () => {
      dispose();
      dom.window.HTMLFormElement.prototype.submit = submit;
      dom.cleanup();
    };
    await flush();
    expect(submitted).toEqual([`${launch.action}&closebutton=1`]);
    const form = dom.root.querySelector("form")!;
    expect(form.querySelector<HTMLInputElement>('input[name="access_token"]')!.value).toBe("body.signature");
    expect(form.querySelector<HTMLInputElement>('input[name="ui_defaults"]')!.value).toContain("UITheme=light");
    expect(form.querySelector<HTMLInputElement>('input[name="ui_defaults"]')!.value).toContain("SavedUIState=false");
    expect(form.querySelector<HTMLInputElement>('input[name="css_variables"]')!.value).toContain("--co-primary-element=");
    expect(dom.root.textContent).toContain("Loading editor");
    const frame = dom.root.querySelector("iframe")!;
    const posted: string[] = [];
    if (frame.contentWindow)
      frame.contentWindow.postMessage = ((message: string) => posted.push(JSON.parse(message).MessageId)) as typeof postMessage;
    const message = (payload: Record<string, unknown>) =>
      dom.window.dispatchEvent(
        new dom.window.MessageEvent("message", {
          data: JSON.stringify(payload),
          source: frame.contentWindow,
          origin: new URL(launch.action).origin,
        }),
      );
    message({ MessageId: "App_LoadingStatus", Values: { Status: "Frame_Ready" } });
    message({ MessageId: "App_LoadingStatus", Values: { Status: "Document_Loaded" } });
    await flush();
    expect(dom.root.textContent).not.toContain("Loading editor");
    if (frame.contentWindow) expect(posted).toEqual(["Host_PostmessageReady", "Hide_Command", "Hide_Command"]);
    message({ MessageId: "UI_Close", Values: { EverModified: false } });
    expect(backs).toEqual([1]);
  });
  test("the editor explains external-write limitations once per browser for writable unmanaged files", async () => {
    const dom = createDomTestHarness();
    delegateEvents(["click"]); // Solid binds delegated clicks to the document that existed at first import.
    const submit = dom.window.HTMLFormElement.prototype.submit;
    dom.window.HTMLFormElement.prototype.submit = () => {};
    const storage = new Map<string, string>();
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const { default: Editor } = await import("../src/frontend/Editor");
    let dispose = () => {};
    cleanup = () => {
      dispose();
      dom.window.HTMLFormElement.prototype.submit = submit;
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      dom.cleanup();
    };
    // Dialogs mount on the next animation frame.
    const settle = async () => {
      await flush();
      await new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)));
      await flush();
    };
    const open = async (current: EditorLaunch) => {
      dispose();
      dispose = render(() => createComponent(Editor, { launch: current, onBack: () => {} }), dom.root);
      await settle();
      return dom.document.querySelector("dialog");
    };
    const dialog = await open({ ...launch, managed: false });
    expect(dialog?.textContent).toContain("Editing outside this editor");
    expect(dialog?.textContent).toContain("Avoid editing this file in other applications at the same time");
    expect(dom.root.textContent).not.toContain("atomic conflict checks");
    expect(storage.size).toBe(0);
    dialog!.querySelector<HTMLButtonElement>(".k2b-dialog__actions button")!.click();
    await settle();
    expect(storage.get("filesv2-editor-external-writes")).toBe("1");
    expect(dom.document.querySelector("dialog")).toBeNull();
    expect(await open({ ...launch, managed: false })).toBeNull();
    storage.clear();
    expect(await open({ ...launch, managed: true })).toBeNull();
    expect(await open({ ...launch, managed: false, canWrite: false })).toBeNull();
    expect(storage.size).toBe(0);
  });
});
