import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult, EditorLaunch } from "../src/contracts";
import type { WorkspaceSnapshot } from "../src/frontend/workspace-state";

const calls: string[] = [];
const base = {
  id: "home",
  area: "cloud" as const,
  kind: "users" as const,
  name: "Alice",
  status: "existing" as const,
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const bases = { items: [base], issues: [], editor: { documentFormat: "odf" as const } };
const directory: DirectoryResult = {
  base,
  path: "",
  items: [{ name: "Minutes.odt", path: "Minutes.odt", directory: false, size: 755, modified: "2026-09-19T10:00:00Z" }],
  next: null,
};
const launch: EditorLaunch = {
  kind: "office",
  managed: true,
  base,
  entry: directory.items[0]!,
  action: "http://localhost:9980/browser/abc/cool.html?WOPISrc=x",
  token: "body.signature",
  tokenTtl: 1_800_000_000_000,
  canWrite: true,
};
if (!isServer) {
  mock.module("@k2b/cloud/browser/search", () => ({ openGlobalSearch: () => {} }));
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        $get: async () => {
          calls.push("bases");
          return Response.json(bases);
        },
        ":baseId": {
          entries: { $get: async () => Response.json(directory) },
          entry: { $get: () => new Promise(() => {}) },
          thumbnail: { $post: () => new Promise(() => {}) },
          editor: {
            $post: async () => {
              calls.push("editor");
              return Response.json(launch);
            },
          },
          uploads: {
            $post: async (input: { json: { path: string; size: number } }) => {
              calls.push(`open ${input.json.path}`);
              return Response.json({
                id: "s1",
                path: input.json.path,
                size: input.json.size,
                chunkSize: 8,
                state: "open",
                url: "https://files.test/lease/s1",
                expires: "2099-01-01T00:00:00Z",
              });
            },
            ":id": {
              commit: {
                $post: async () => {
                  calls.push("commit");
                  return Response.json({ base, entry: { name: "report.pdf", path: "report.pdf", directory: false, size: 8 } });
                },
              },
              abort: {
                $post: async () => {
                  calls.push("abort");
                  return Response.json({ aborted: true });
                },
              },
              lease: { $post: async () => Response.json({ url: "https://files.test/lease/s1", expires: "2099-01-01T00:00:00Z" }) },
            },
          },
        },
      },
    },
  }));
}

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const originalFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

describe("uploads in the Files workspace", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions test process", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    calls.length = 0;
    globalThis.fetch = originalFetch;
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("opening a document in the editor while a file uploads does not cancel the upload", async () => {
    // The file server holds the first segment until the test lets it through.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received = 0;
    let aborted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.searchParams.has("segments")) return Response.json({ items: [] });
      if (init?.method === "PUT") {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        await held;
        received += (await new Response(init.body as BodyInit).arrayBuffer()).byteLength;
      }
      return Response.json({ id: "s1", root: "cloud", size: 8, chunkSize: 8, expires: "2099-01-01T00:00:00Z", state: "open", received });
    }) as typeof fetch;
    const dom = createDomTestHarness();
    dom.document.body.className = "k2b-ui";
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    const initial: WorkspaceSnapshot = { source: "/app/filesv2?base=home", bases, selectedId: base.id, directory, errorCode: null };
    dom.window.history.replaceState(null, "", initial.source);
    const { default: Workspace } = await import("../src/frontend/Workspace.island");
    const dispose = render(() => createComponent(Workspace, { initial, cloudUrl: "https://cloud.test" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    await wait();

    const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdefgh"], "report.pdf")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await wait();
    const title = () => dom.document.querySelector(".filesv2-upload__title")?.textContent;
    expect(title()).toBe("Uploading to “My files”");

    // Open the document: the folder view leaves, the editor takes its place.
    dom.root.querySelector('[role="row"].filesv2-list__row')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await wait(80);
    expect(calls).toEqual(["open report.pdf", "bases", "editor"]);
    expect(dom.root.querySelector(".filesv2-browser")).toBeNull();
    expect(dom.root.querySelector("iframe")).not.toBeNull();
    expect(title()).toBe("Uploading to “My files”");

    release();
    await wait(80);
    expect(aborted).toBeFalse();
    expect(calls).toEqual(["open report.pdf", "bases", "editor", "commit"]);
    expect(received).toBe(8);
    expect(title()).toBe("Uploaded to “My files”");
  });
});
