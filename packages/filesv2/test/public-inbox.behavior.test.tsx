import { afterEach, expect, mock, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PublicShare } from "../src/contracts";

let creates = 0,
  commits = 0,
  aborts = 0;
let commitFails = false;
let startKey = "";
mock.module("../src/frontend/public-client", () => ({
  publicClient: {
    inbox: {
      ":token": {
        api: {
          uploads: {
            $post: async (input: { json: { idempotencyKey: string } }) => {
              creates++;
              startKey = input.json.idempotencyKey;
              return Response.json({
                id: "s1",
                path: "file",
                size: 0,
                chunkSize: 8 * 1024 * 1024,
                state: "committed",
                expires: "2099-01-01",
              });
            },
            ":id": {
              commit: {
                $post: async () => {
                  commits++;
                  if (commitFails) throw new Error("lost commit response");
                  return Response.json({ name: "file.txt" });
                },
              },
              abort: {
                $post: async () => {
                  aborts++;
                  return Response.json({});
                },
              },
              lease: {
                $post: async () => {
                  throw new Error("must not renew a committed replay");
                },
              },
            },
          },
        },
      },
    },
  },
}));
const share: PublicShare = {
  kind: "inbox",
  title: "Inbox",
  expiresAt: null,
  items: [],
  note: null,
  path: "",
  next: null,
  maxFileSize: 1024,
  maxTotalSize: 4096,
  showUploadNames: false,
  uploadedNames: [],
};
let cleanup = () => {};
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  cleanup();
  creates = 0;
  commits = 0;
  aborts = 0;
  startKey = "";
  commitFails = false;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

test("public inbox terminal replay requests its Cloud receipt without a direct lease", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={share} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([], "file.txt", { lastModified: 123 })] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(creates).toBe(1);
  expect(startKey).toMatch(/^[a-f0-9-]{36}$/);
  expect(commits).toBe(1);
  expect(aborts).toBe(0);
  expect(dom.root.textContent).toContain("file.txt");
  expect(localStorage.length).toBe(0);
});

test("public inbox keeps its durable start key after an ambiguous commit and never aborts it", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={share} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  commitFails = true;
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([], "file.txt", { lastModified: 123 })] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(commits).toBe(1);
  expect(aborts).toBe(0);
  const key = startKey;
  expect(localStorage.length).toBe(1);
  commitFails = false;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(startKey).toBe(key);
  expect(commits).toBe(2);
  expect(localStorage.length).toBe(0);
});
