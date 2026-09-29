import { afterEach, expect, mock, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult } from "../src/contracts";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const calls: string[] = [];
const targetBases = new Set<string>();
let openStatus = 200;
mock.module("../src/api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": {
        entry: { $get: () => new Promise(() => {}) },
        directories: {
          $post: async (input: { param: { baseId: string }; json: { path: string } }) => {
            targetBases.add(input.param.baseId);
            calls.push(`mkdir ${input.json.path}`);
            return Response.json({ base: initial.base, entry: { name: "", path: input.json.path, directory: true } });
          },
        },
        uploads: {
          $post: async (input: { param: { baseId: string }; json: { path: string; size: number; onConflict: string } }) => {
            targetBases.add(input.param.baseId);
            calls.push(`open ${input.json.path} ${input.json.size} ${input.json.onConflict}`);
            if (openStatus !== 200) return Response.json({ code: "path_conflict", message: "exists" }, { status: openStatus });
            return Response.json({
              id: "s1",
              path: input.json.path,
              size: input.json.size,
              chunkSize: 4,
              state: "open",
              url: "https://files.test/lease/s1",
              expires: "2099-01-01T00:00:00Z",
            });
          },
          ":id": {
            commit: {
              $post: async () => {
                calls.push("commit");
                return Response.json({ base: initial.base, entry: { ...file, size: 6 } });
              },
            },
            abort: {
              $post: async () => {
                calls.push("abort");
                return Response.json({ aborted: true });
              },
            },
            lease: { $post: async () => Response.json({ url: "https://files.test/lease/s1-renewed", expires: "2099-01-01T00:00:00Z" }) },
          },
        },
      },
    },
  },
}));
const file = { name: "notes.txt", path: "Documents/notes.txt", directory: false, size: 6, modified: "2026-09-18T00:00:00Z" };
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
  path: "Documents",
  items: [],
  next: null,
};
let received = 0;
const originalFetch = globalThis.fetch;
const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
let cleanup = () => {};
afterEach(() => {
  cleanup();
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
  calls.length = 0;
  targetBases.clear();
  received = 0;
  openStatus = 200;
  globalThis.fetch = originalFetch;
});

test("uploads stream to the session lease without Cloud credentials, then commit and refresh the folder", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("https://files.test/lease/s1")).toBeTrue();
    expect(init?.credentials).toBe("omit");
    const status = () => ({
      id: "s1",
      root: "cloud",
      size: 6,
      chunkSize: 4,
      expires: "2099-01-01T00:00:00Z",
      state: "open",
      uploadedSegments: 0,
      received,
    });
    if (new URL(url).searchParams.has("segments")) return Response.json({ items: [] });
    if (init?.method === "PUT") {
      calls.push(`put ${new URL(url).searchParams.get("segment")}`);
      received += (await new Response(init.body as BodyInit).arrayBuffer()).byteLength;
    } else calls.push("status");
    return Response.json(status());
  }) as typeof fetch;
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: Browser } = await import("../src/frontend/Browser");
  let created = "";
  const dispose = render(
    () => (
      <Browser
        directory={initial}
        bases={[initial.base]}
        cloudUrl="https://cloud.test"
        onNavigate={async () => {}}
        onChanged={(path) => (created = path ?? "")}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "notes.txt")] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(calls).toEqual(["open Documents/notes.txt 6 error", "status", "put 0", "put 1", "commit"]);
  expect(received).toBe(6);
  expect(created).toBe("Documents/notes.txt");
});

test("an existing name asks before replacing and skipping leaves the file untouched", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      id: "s1",
      root: "cloud",
      size: 0,
      chunkSize: 4,
      expires: "2099-01-01T00:00:00Z",
      state: "open",
      uploadedSegments: 0,
      received: 0,
    })) as typeof fetch;
  openStatus = 409;
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: Browser } = await import("../src/frontend/Browser");
  let created = "";
  const dispose = render(
    () => (
      <Browser
        directory={initial}
        bases={[initial.base]}
        cloudUrl="https://cloud.test"
        onNavigate={async () => {}}
        onChanged={(path) => (created = path ?? "")}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([], "notes.txt")] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  const dialog = dom.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("notes.txt");
  const buttons = [...dialog.querySelectorAll("button")];
  buttons.find((button) => button.textContent?.trim() === "Skip")!.click();
  await flush();
  expect(calls).toEqual(["open Documents/notes.txt 0 error"]);
  expect(created).toBe("");
  // Replacing reopens the session with overwrite.
  openStatus = 200;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(calls.at(-1)).toBe("commit");
});

// Hidden system files: one question per folder upload, asked before anything is created.
const emptySession = (async () =>
  Response.json({
    id: "s1",
    root: "cloud",
    size: 0,
    chunkSize: 4,
    expires: "2099-01-01T00:00:00Z",
    state: "open",
    uploadedSegments: 0,
    received: 0,
  })) as unknown as typeof fetch;
async function mountBrowser(directory: () => DirectoryResult = () => initial) {
  globalThis.fetch = emptySession;
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: Browser } = await import("../src/frontend/Browser");
  const dispose = render(
    () => (
      <Browser
        directory={directory()}
        bases={[initial.base]}
        cloudUrl="https://cloud.test"
        onNavigate={async () => {}}
        onChanged={() => {}}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  return dom;
}
const picked = (path: string) => {
  const value = new File([], path.split("/").at(-1)!);
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
};
const pickFolder = (dom: ReturnType<typeof createDomTestHarness>, paths: string[]) => {
  const input = dom.root.querySelector<HTMLInputElement>("input[webkitdirectory]")!;
  Object.defineProperty(input, "files", { configurable: true, value: paths.map(picked) });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};
const answer = (dom: ReturnType<typeof createDomTestHarness>, label: string) =>
  [...dom.document.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.trim() === label)!.click();
const pickedFolder = [
  "Photos/beach.jpg",
  "Photos/.DS_Store",
  "Photos/.gitignore",
  "Photos/2026/Thumbs.db",
  "Photos/.Spotlight-V100/Store-V2/index",
];

test("a picked folder with system files asks once and skipping them never creates their folders", async () => {
  const dom = await mountBrowser();
  pickFolder(dom, pickedFolder);
  await flush();
  const dialog = dom.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("This upload contains 3 hidden system files (e.g. .DS_Store, Thumbs.db). Include them?");
  expect(dialog.textContent).toContain(".gitignore or .env, are not affected by this choice");
  expect(calls).toEqual([]);
  answer(dom, "Upload without system files");
  await flush();
  expect(dom.document.querySelector("dialog")).toBeNull();
  expect(calls.filter((call) => call.startsWith("mkdir"))).toEqual(["mkdir Documents/Photos", "mkdir Documents/Photos/2026"]);
  expect(calls.filter((call) => call.startsWith("open"))).toEqual([
    "open Documents/Photos/beach.jpg 0 error",
    "open Documents/Photos/.gitignore 0 error",
  ]);
});

test("navigating while the system-files question is open still uploads into the folder the upload started in", async () => {
  const [directory, setDirectory] = createSignal(initial);
  const dom = await mountBrowser(directory);
  pickFolder(dom, pickedFolder);
  await flush();
  // Browser history moves the same mounted browser to a group base behind the open dialog.
  setDirectory({ ...initial, base: { ...initial.base, id: "team", name: "Team", kind: "groups" }, path: "Shared" });
  await flush();
  answer(dom, "Upload without system files");
  await flush();
  expect([...targetBases]).toEqual(["home"]);
  expect(calls.filter((call) => call.startsWith("mkdir"))).toEqual(["mkdir Documents/Photos", "mkdir Documents/Photos/2026"]);
  expect(calls.filter((call) => call.startsWith("open"))).toEqual([
    "open Documents/Photos/beach.jpg 0 error",
    "open Documents/Photos/.gitignore 0 error",
  ]);
});

test("uploading everything keeps system files and cancelling uploads nothing", async () => {
  const dom = await mountBrowser();
  pickFolder(dom, pickedFolder);
  await flush();
  answer(dom, "Cancel");
  await flush();
  expect(calls).toEqual([]);
  pickFolder(dom, pickedFolder);
  await flush();
  answer(dom, "Upload all");
  await flush();
  expect(calls.filter((call) => call.startsWith("mkdir"))).toEqual([
    "mkdir Documents/Photos",
    "mkdir Documents/Photos/.Spotlight-V100",
    "mkdir Documents/Photos/.Spotlight-V100/Store-V2",
    "mkdir Documents/Photos/2026",
  ]);
  expect(calls.filter((call) => call.startsWith("open"))).toHaveLength(5);
});

test("uploads without system files, and files picked directly, start without a question", async () => {
  const dom = await mountBrowser();
  pickFolder(dom, ["Project/.gitignore", "Project/src/.env"]);
  await flush();
  expect(dom.document.querySelector("dialog")).toBeNull();
  expect(calls.filter((call) => call.startsWith("open"))).toEqual([
    "open Documents/Project/.gitignore 0 error",
    "open Documents/Project/src/.env 0 error",
  ]);
  calls.length = 0;
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]:not([webkitdirectory])')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([], ".DS_Store")] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(dom.document.querySelector("dialog")).toBeNull();
  expect(calls).toEqual(["open Documents/.DS_Store 0 error", "commit"]);
});

function fileEntry(name: string): FileSystemEntry {
  return {
    name,
    isDirectory: false,
    isFile: true,
    file: (resolve: (file: File) => void) => resolve(new File([], name)),
  } as FileSystemFileEntry;
}
function directoryEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    name,
    isDirectory: true,
    isFile: false,
    createReader: () => {
      let done = false;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) => {
          resolve(done ? [] : children);
          done = true;
        },
      };
    },
  } as FileSystemDirectoryEntry;
}

test("a dropped folder skips Windows and macOS system entries, including everything under a system folder", async () => {
  const dom = await mountBrowser();
  const entries = [
    directoryEntry("Docs", [
      fileEntry("report.txt"),
      fileEntry("desktop.ini"),
      fileEntry("._report.txt"),
      directoryEntry("$RECYCLE.BIN", [directoryEntry("S-1-5-21", [fileEntry("$I1.txt")])]),
      directoryEntry("Empty", []),
    ]),
  ];
  const event = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })), files: [], types: ["Files"] },
  });
  dom.root.querySelector(".filesv2-browser__surface")!.dispatchEvent(event);
  await flush();
  const dialog = dom.document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("This upload contains 3 hidden system files (e.g. desktop.ini, ._report.txt). Include them?");
  answer(dom, "Upload without system files");
  await flush();
  expect(calls).toEqual(["mkdir Documents/Docs", "mkdir Documents/Docs/Empty", "open Documents/Docs/report.txt 0 error", "commit"]);
});
