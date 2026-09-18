import { afterEach, expect, mock, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { DirectoryResult } from "../src/contracts";

const calls: string[] = [];
let openStatus = 200;
mock.module("../src/api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": {
        entry: { $get: () => new Promise(() => {}) },
        uploads: {
          $post: async (input: { json: { path: string; size: number; onConflict: string } }) => {
            calls.push(`open ${input.json.path} ${input.json.size} ${input.json.onConflict}`);
            if (openStatus !== 200) return Response.json({ message: "exists" }, { status: openStatus });
            return Response.json({ id: "s1", path: input.json.path, size: input.json.size, chunkSize: 4, url: "https://files.test/lease/s1", expires: "2099-01-01T00:00:00Z" });
          },
          ":id": {
            commit: { $post: async () => { calls.push("commit"); return Response.json({ base: initial.base, entry: { ...file, size: 6 } }); } },
            abort: { $post: async () => { calls.push("abort"); return Response.json({ aborted: true }); } },
            lease: { $post: async () => Response.json({ url: "https://files.test/lease/s1-renewed", expires: "2099-01-01T00:00:00Z" }) },
          },
        },
      },
    },
  },
}));
const file = { name: "notes.txt", path: "Documents/notes.txt", directory: false, size: 6, modified: "2026-09-18T00:00:00Z" };
const initial: DirectoryResult = {
  base: { id: "home", name: "Home", area: "cloud", kind: "users", status: "existing", reason: null, indexEnabled: false, versioningEnabled: false },
  path: "Documents",
  items: [],
  next: null,
};
let received = 0;
const originalFetch = globalThis.fetch;
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };
let cleanup = () => {};
afterEach(() => {
  cleanup();
  calls.length = 0;
  received = 0;
  openStatus = 200;
  globalThis.fetch = originalFetch;
});

test("uploads stream to the session lease without Cloud credentials, then commit and refresh the folder", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith("https://files.test/lease/s1")).toBeTrue();
    expect(init?.credentials).toBe("omit");
    const status = () => ({ id: "s1", root: "cloud", size: 6, chunkSize: 4, expires: "2099-01-01T00:00:00Z", state: "open", segments: {}, received });
    if (init?.method === "PUT") {
      calls.push(`put ${new URL(url).searchParams.get("segment")}`);
      received += (await new Response(init.body as BodyInit).arrayBuffer()).byteLength;
    } else calls.push("status");
    return Response.json(status());
  }) as typeof fetch;
  const dom = createDomTestHarness();
  const { default: Browser } = await import("../src/frontend/Browser");
  let created = "";
  const dispose = render(() => <Browser directory={initial} onNavigate={async () => {}} onCreated={(path) => (created = path)} />, dom.root);
  cleanup = () => { dispose(); dom.cleanup(); };
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["abcdef"], "notes.txt")] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(calls).toEqual(["open Documents/notes.txt 6 error", "status", "put 0", "put 1", "commit"]);
  expect(received).toBe(6);
  expect(created).toBe("Documents/notes.txt");
});

test("an existing name asks before replacing and skipping leaves the file untouched", async () => {
  globalThis.fetch = (async () => Response.json({ id: "s1", root: "cloud", size: 0, chunkSize: 4, expires: "2099-01-01T00:00:00Z", state: "open", segments: {}, received: 0 })) as typeof fetch;
  openStatus = 409;
  const dom = createDomTestHarness();
  const { default: Browser } = await import("../src/frontend/Browser");
  let created = "";
  const dispose = render(() => <Browser directory={initial} onNavigate={async () => {}} onCreated={(path) => (created = path)} />, dom.root);
  cleanup = () => { dispose(); dom.cleanup(); };
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
