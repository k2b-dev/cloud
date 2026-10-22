import { afterEach, beforeEach, expect, jest, mock, setSystemTime, test } from "bun:test";
import { setImmediate } from "node:timers";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PublicShare } from "../src/contracts";

let creates = 0,
  commits = 0,
  aborts = 0,
  nameLoads = 0;
let commitFails = false;
let commitStatus = 200;
let startCode = "";
let openSession = false;
let startKey = "";
let rateLimitPhase: "start" | "commit" = "start";
let rateLimitAt = 0;
let retryAfter = "1";
let holdNames: Promise<void> | undefined;
let namesFromCommits = false;
const rateLimitResponse = () => Response.json({ message: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": retryAfter } });
mock.module("../src/frontend/public-client", () => ({
  publicClient: {
    inbox: {
      ":token": {
        api: {
          // The page budget is 10 per minute; a refresh per file would run into it.
          $get: async () => {
            nameLoads++;
            if (nameLoads > 10) return rateLimitResponse();
            // The server answers with the names committed when the read started.
            const uploadedNames = namesFromCommits ? Array.from({ length: commits }, (_, i) => `file-${i}.txt`) : ["file.txt"];
            const hold = holdNames;
            holdNames = undefined;
            await hold;
            return Response.json({ ...share, uploadedNames });
          },
          uploads: {
            $post: async (input: { json: { idempotencyKey: string } }) => {
              creates++;
              startKey = input.json.idempotencyKey;
              if (rateLimitPhase === "start" && creates === rateLimitAt) return rateLimitResponse();
              if (startCode) return Response.json({ code: startCode, message: "Upload changed" }, { status: 409 });
              return Response.json({
                id: "s1",
                path: "file",
                size: 0,
                chunkSize: 8 * 1024 * 1024,
                state: openSession ? "open" : "committed",
                ...(openSession ? { url: "https://files.test/lease/s1" } : {}),
                expires: "2099-01-01",
              });
            },
            ":id": {
              commit: {
                $post: async () => {
                  commits++;
                  if (rateLimitPhase === "commit" && commits === rateLimitAt) return rateLimitResponse();
                  if (commitStatus !== 200) return Response.json({ message: "unavailable" }, { status: commitStatus });
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
const resumeKeys = () =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).filter((key) => key.startsWith("filesv2:upload:"));
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const nativeFetch = globalThis.fetch;
beforeEach(() => setSystemTime(new Date("2026-10-15T00:00:00Z")));
afterEach(() => {
  setSystemTime();
  globalThis.fetch = nativeFetch;
  startCode = "";
  commitStatus = 200;
  openSession = false;
  cleanup();
  if (jest.isFakeTimers()) {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
  creates = 0;
  commits = 0;
  aborts = 0;
  nameLoads = 0;
  startKey = "";
  commitFails = false;
  rateLimitPhase = "start";
  rateLimitAt = 0;
  retryAfter = "1";
  holdNames = undefined;
  namesFromCommits = false;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});
const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
const settle = async (condition: () => boolean) => {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
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
  expect(resumeKeys()).toHaveLength(1);
  commitFails = false;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(startKey).toBe(key);
  expect(commits).toBe(2);
  expect(localStorage.length).toBe(0);
});

test("a file over the inbox limit is named once and never becomes a row that could be retried", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={share} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File([new Uint8Array(2048)], "video.mp4"), new File([], "file.txt", { lastModified: 123 })],
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  expect(creates).toBe(1);
  expect([...dom.document.querySelectorAll(".filesv2-upload-row__base")].map((node) => node.textContent)).toEqual(["file.txt"]);
  expect(
    [...dom.document.querySelectorAll("[data-k2b-toast]:not([data-custom]) .k2b-toast__description")].map((node) => node.textContent),
  ).toEqual(["“video.mp4” exceeds the inbox's per-file limit."]);
});

test("public inbox keeps an open session after transient commit failure and drops final start keys", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  globalThis.fetch = Object.assign(
    async () => Response.json({ id: "s1", root: "cloud", size: 0, chunkSize: 8 * 1024 * 1024, state: "open", received: 0 }),
    { preconnect: nativeFetch.preconnect },
  );
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={share} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  jest.useFakeTimers();
  openSession = true;
  commitStatus = 503;
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([], "file.txt", { lastModified: 123 })] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(() => commits === 1 && !!dom.document.querySelector('[data-wait="busy"]'));
  expect(commits).toBe(1);
  expect(aborts).toBe(0);
  expect(resumeKeys()).toHaveLength(1);
  const original = startKey;
  startCode = "upload_changed";
  jest.advanceTimersByTime(2000);
  await settle(() => creates === 2 && !!dom.document.querySelector('[data-status="failed"]'));
  expect(creates).toBe(2);
  expect(startKey).toBe(original);
  expect(localStorage.length).toBe(0);
  expect(aborts).toBe(0);
  expect(dom.document.querySelector(".filesv2-upload-row__reason")?.textContent).toBe("Upload changed");
});

test.each(["start", "commit"] as const)("public inbox waits for Retry-After midway through 15 files (%s)", async (phase) => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={share} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  jest.useFakeTimers();
  rateLimitPhase = phase;
  rateLimitAt = 8;
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: Array.from({ length: 15 }, (_, i) => new File([], `file-${i}.txt`, { lastModified: 123 })),
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(() => !!dom.document.querySelector('[data-wait="rate_limited"]'));
  expect(dom.document.querySelector('[data-wait="rate_limited"] .filesv2-upload-row__reason')?.textContent).toBe(
    "Short pause after many uploads",
  );
  jest.advanceTimersByTime(999);
  expect(dom.document.querySelector('[data-wait="rate_limited"]')).not.toBeNull();
  jest.advanceTimersByTime(1);
  await settle(() => !!dom.document.querySelector('.filesv2-upload[data-phase="done"]'));
  // The panel virtualizes its rows; the batch summary counts all 15 files.
  expect(dom.document.querySelector(".filesv2-upload__count")?.textContent).toBe("15 of 15 files");
  expect(dom.document.querySelectorAll('[data-status="success"]').length).toBeGreaterThan(0);
  expect(dom.document.querySelectorAll('[data-status="failed"]')).toHaveLength(0);
  expect(creates).toBe(16);
  expect(commits).toBe(phase === "start" ? 15 : 16);
  expect(aborts).toBe(0);
  expect(localStorage.length).toBe(0);
});

test("public inbox shows its own rate-limit reason when Retry-After exceeds five minutes", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={share} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  jest.useFakeTimers();
  rateLimitAt = 1;
  retryAfter = "301";
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File([], "file.txt", { lastModified: 123 })] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(() => !!dom.document.querySelector('[data-status="failed"]'));
  expect(dom.document.querySelector('[data-status="failed"] .filesv2-upload-row__reason')?.textContent).toBe(
    "Too many uploads in a short time",
  );
  expect(dom.document.querySelector('[data-wait="rate_limited"]')).toBeNull();
  expect(creates).toBe(1);
  expect(commits).toBe(0);
});

test("public inbox refreshes the received names once per batch instead of once per file", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={{ ...share, showUploadNames: true }} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: Array.from({ length: 15 }, (_, i) => new File([], `file-${i}.txt`, { lastModified: 123 })),
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(() => !!dom.document.querySelector('.filesv2-upload[data-phase="done"]') && nameLoads > 0);
  await flush();
  expect(dom.document.querySelector(".filesv2-upload__count")?.textContent).toBe("15 of 15 files");
  expect(commits).toBe(15);
  expect(nameLoads).toBe(1);
  expect(dom.document.querySelectorAll("[data-k2b-toast]:not([data-custom])")).toHaveLength(0);
  expect(dom.root.querySelector('[aria-label="Received file names"] li')?.textContent).toBe("file.txt");
});

test("public inbox refreshes the received names again when a batch settles during a refresh", async () => {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
  const dispose = render(() => <PublicInbox token="public-secret" share={{ ...share, showUploadNames: true }} />, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  let release = () => {};
  namesFromCommits = true;
  holdNames = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
  const drop = (name: string) => {
    Object.defineProperty(input, "files", { configurable: true, value: [new File([], name, { lastModified: 123 })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  drop("file-0.txt");
  await settle(() => commits === 1 && nameLoads === 1);
  drop("file-1.txt");
  await settle(() => commits === 2);
  await flush();
  expect(nameLoads).toBe(1);
  release();
  await settle(() => nameLoads === 2);
  await flush();
  const listed = () => Array.from(dom.root.querySelectorAll('[aria-label="Received file names"] li'), (item) => item.textContent);
  expect(listed()).toEqual(["file-0.txt", "file-1.txt"]);
});
