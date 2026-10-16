import { afterEach, beforeEach, expect, jest, mock, setSystemTime, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers";
import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { PublicShare } from "../src/contracts";
import type { FilesUploads } from "../src/frontend/files-uploads";
import type { UploadAnnouncement } from "../src/frontend/upload-batch";

const nativeFetch = globalThis.fetch;
const nativeTimeout = AbortSignal.timeout;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const base = {
  id: "home",
  area: "cloud",
  kind: "users",
  name: "Home",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
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
const starts: { path: string; key: string }[] = [];
const committed: string[] = [];
let aborts = 0;
let online = true;
let dropAfter = 0;
let busy = false;
let stalled = false;
let rateLimits = 0;
let ratePhase: "start" | "commit" = "start";
let puts = 0;
const received = new Set<string>();
let startOverride: (() => Promise<Response>) | undefined;
let prepareOverride: (() => Promise<Response>) | undefined;
const open = async (input: { json: { path?: string; name?: string; size: number; idempotencyKey: string } }) => {
  const path = input.json.path ?? input.json.name!;
  starts.push({ path, key: input.json.idempotencyKey });
  if (startOverride) return startOverride();
  if (!online) throw new TypeError("offline");
  if (ratePhase === "start" && rateLimits-- > 0) return rateLimit();
  return Response.json({
    id: path,
    path,
    size: input.json.size,
    chunkSize: 8,
    state: "open",
    url: `https://files.test/lease/${path}`,
    expires: "2099-01-01",
  });
};
const rateLimit = () => Response.json({ code: "rate_limited" }, { status: 429, headers: { "Retry-After": "3" } });
const commit = async (input: { param: { id: string } }) => {
  if (!online) throw new TypeError("offline");
  if (ratePhase === "commit" && rateLimits-- > 0) return rateLimit();
  const path = input.param.id;
  committed.push(path);
  if (dropAfter && committed.length === dropAfter) online = false;
  return Response.json({ base, entry: { path, name: path, size: 1, directory: false }, name: path });
};
const uploadsApi = {
  $post: open,
  ":id": {
    commit: { $post: commit },
    abort: {
      $post: async () => {
        aborts++;
        return Response.json({});
      },
    },
    lease: {
      $post: async () => {
        throw new Error("must not renew");
      },
    },
  },
};
mock.module("../src/api/client", () => ({
  apiClient: {
    bases: {
      ":baseId": { uploads: uploadsApi, directories: { $post: async () => (prepareOverride ? prepareOverride() : Response.json({})) } },
    },
  },
}));
mock.module("../src/frontend/public-client", () => ({ publicClient: { inbox: { ":token": { api: { uploads: uploadsApi } } } } }));

// UI modules need a document while their browser exports are evaluated.
const loadDom = createDomTestHarness();
const { createFilesUploads } = await import("../src/frontend/files-uploads");
const { UploadSurface } = await import("../src/frontend/UploadPanel");
const { default: PublicInbox } = await import("../src/frontend/PublicInbox.island");
const { createUploadQueue } = await import("../src/frontend/upload-queue");
loadDom.cleanup();

let cleanup: () => void | Promise<void> = () => {};
let restoreDeadline = () => {};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};
const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 1000;
  while (!condition() && performance.now() < deadline) await flush();
  expect(condition()).toBe(true);
};
const advance = async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await flush();
};
const file = (name: string) => new File(["x"], name, { lastModified: 123 });

function mount(inbox = false) {
  const dom = createDomTestHarness();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  dom.document.body.className = "k2b-ui";
  let queue!: FilesUploads;
  const said: UploadAnnouncement[] = [];
  const dispose = render(() => {
    if (inbox) return <PublicInbox token="public-secret" share={share} />;
    queue = createFilesUploads();
    queue.listen((event) => said.push(event));
    return <UploadSurface queue={queue} />;
  }, dom.root);
  cleanup = () => {
    dispose();
    dom.cleanup();
  };
  const add = (...files: File[]) => {
    if (inbox) {
      const input = dom.root.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else
      queue.add(
        { baseId: "home", root: "", folders: [], policy: "overwrite", total: files.length },
        { key: "home", label: "Home" },
        files.map((file) => ({ file, path: file.name })),
      );
  };
  const panel = () => dom.document.querySelector<HTMLElement>(".filesv2-upload")!;
  const title = () => panel()?.querySelector(".filesv2-upload__title")?.textContent;
  const reason = () => panel()?.querySelector('[data-status="working"] .filesv2-upload-row__reason')?.textContent;
  return { dom, queue: () => queue, add, panel, title, reason, said, dispose };
}

beforeEach(() => {
  setSystemTime(new Date("2026-10-16T00:00:00Z"));
  jest.useFakeTimers();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!online) throw new TypeError("offline");
      const url = new URL(String(input));
      const id = url.pathname.split("/").at(-1)!;
      if (url.searchParams.has("segments")) return Response.json({ items: [] });
      if (init?.method === "PUT") {
        puts++;
        if (id === "first.txt" && stalled)
          return new Promise<Response>((_, reject) => {
            init.signal?.throwIfAborted();
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          });
        if (busy) return Response.json({ error: "operation_busy" }, { status: 503, headers: { "Retry-After": "3" } });
        received.add(id);
      }
      return Response.json({ id, root: "cloud", size: 1, chunkSize: 8, state: "open", received: received.has(id) ? 1 : 0 });
    },
    { preconnect: nativeFetch.preconnect },
  );
});
afterEach(async () => {
  await cleanup();
  cleanup = () => {};
  restoreDeadline();
  restoreDeadline = () => {};
  const { toast } = await import("@k2b/ui");
  toast.dismissAll();
  jest.clearAllTimers();
  jest.useRealTimers();
  setSystemTime();
  globalThis.fetch = nativeFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
  starts.length = 0;
  committed.length = 0;
  received.clear();
  aborts = puts = dropAfter = rateLimits = 0;
  ratePhase = "start";
  online = true;
  busy = stalled = false;
  startOverride = prepareOverride = undefined;
});

test("#1167: losing the network after file 8 holds row 9 and all 21 pending files, then resumes the same key", async () => {
  const ui = mount();
  dropAfter = 8;
  ui.add(...Array.from({ length: 30 }, (_, i) => file(`${i + 1}.txt`)));
  await until(() => ui.queue().batch.rows[8]?.wait === "network");
  expect(ui.title()).toBe("Waiting for network");
  expect(ui.reason()).toBe("Waiting for network");
  expect(
    ui
      .queue()
      .batch.rows.slice(9)
      .map((row) => row.status),
  ).toEqual(Array(21).fill("pending"));
  // The list is virtualized; scroll through every pending row to check its rendered status too.
  const list = ui.panel().querySelector<HTMLElement>(".filesv2-upload__list")!.parentElement!;
  for (const index of [14, 24, 29]) {
    list.scrollTop = index * 36;
    list.dispatchEvent(new Event("scroll"));
    expect([...list.querySelectorAll<HTMLElement>("[data-status]")].every((row) => row.dataset.status === "pending")).toBe(true);
  }
  expect(aborts).toBe(0);
  await advance(120_000);
  expect(starts).toHaveLength(9);
  const key = starts[8]!.key;
  dropAfter = 0;
  online = true;
  window.dispatchEvent(new Event("online"));
  await until(() => ui.queue().batch.phase === "done");
  expect(starts[9]).toEqual({ path: "9.txt", key });
  expect(ui.title()).toBe("Uploaded to “Home”");
  expect(ui.panel().querySelector(".filesv2-upload__count")?.textContent).toBe("30 of 30 files");
  expect(aborts).toBe(0);
});

test("#1163: a stalled PUT uses the request deadline, retries five times on one key, then starts the next file", async () => {
  const deadline = spyOn(AbortSignal, "timeout").mockImplementation((ms) => nativeTimeout(ms > 60_000 ? 15 : ms));
  restoreDeadline = () => deadline.mockRestore();
  const ui = mount();
  stalled = true;
  ui.add(file("first.txt"), file("next.txt"));
  const delays = [2000, 5000, 15000, 30000, 60000];
  for (let i = 0; i < delays.length; i++) {
    await until(() => puts === i + 1);
    await advance(15);
    await until(() => ui.queue().batch.rows[0]?.wait === "stalled" && starts.length === i + 1);
    expect(ui.reason()).toBe("No response, trying again soon");
    expect(ui.queue().batch.rows[1]!.status).toBe("pending");
    await advance(delays[i]!);
  }
  await until(() => puts === 6);
  await advance(15);
  await until(() => ui.queue().batch.phase === "errors");
  expect(starts.filter((start) => start.path === "first.txt")).toHaveLength(6);
  expect(new Set(starts.filter((start) => start.path === "first.txt").map((start) => start.key)).size).toBe(1);
  expect(puts).toBe(7);
  expect(ui.queue().batch.rows.map((row) => row.status)).toEqual(["failed", "success"]);
  expect(ui.panel().querySelector(".filesv2-upload-row__reason")?.textContent).toBe("No response from the file server");
  expect(aborts).toBe(0);
});

test("a segment 503 operation_busy respects Retry-After before reopening the same session", async () => {
  const ui = mount();
  busy = true;
  ui.add(file("first.txt"));
  await until(() => ui.queue().batch.rows[0]?.wait === "busy");
  expect(ui.reason()).toBe("File server busy, trying again soon");
  await advance(2900);
  expect(starts).toHaveLength(1);
  expect(puts).toBe(1);
  busy = false;
  await advance(100);
  await until(() => ui.queue().batch.phase === "done");
  expect(starts).toHaveLength(2);
  expect(starts[1]!.key).toBe(starts[0]!.key);
  expect(aborts).toBe(0);
});

test.each(["start", "commit"] as const)(
  "public inbox waits through six 429 %s answers without spending the five retries",
  async (phase) => {
    const ui = mount(true);
    ratePhase = phase;
    rateLimits = 6;
    ui.add(file("public.txt"));
    for (let i = 0; i < 6; i++) {
      await until(() => ui.reason() === "Short pause after many uploads" && starts.length === i + 1);
      await advance(2900);
      expect(starts).toHaveLength(i + 1);
      await advance(100);
    }
    await until(() => ui.title() === "Uploaded to “Inbox”");
    expect(starts).toHaveLength(7);
    expect(new Set(starts.map((start) => start.key)).size).toBe(1);
    expect(committed).toEqual(["public.txt"]);
    expect(aborts).toBe(0);
  },
);

test.each(["network", "busy"] as const)("Cancel during a %s wait wakes immediately and cannot touch a later batch", async (kind) => {
  const ui = mount();
  online = kind !== "network";
  busy = kind === "busy";
  ui.add(file("first.txt"));
  await until(() => ui.queue().batch.rows[0]?.wait === kind);
  ui.queue().cancel();
  expect(ui.queue().batch.phase).toBe("cancelled");
  online = true;
  busy = false;
  // Add before the old wait's continuation has even run.
  ui.add(file("later.txt"));
  await until(() => ui.queue().batch.phase === "done");
  expect(ui.queue().batch.rows.map((row) => [row.path, row.status])).toEqual([["later.txt", "success"]]);
  const count = starts.length;
  await advance(600_000);
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(starts).toHaveLength(count);
  expect(starts.map((start) => start.path)).toEqual(["first.txt", "later.txt"]);
});

test("several failed probes announce offline once; an OK start announces online once in the live region", async () => {
  const ui = mount();
  startOverride = async () => {
    throw new TypeError("offline despite online hint");
  };
  ui.add(file("first.txt"));
  await until(() => ui.queue().batch.rows[0]?.wait === "network");
  await advance(60);
  const live = () => ui.panel().querySelector('[role="status"]')?.textContent;
  expect(live()).toBe("Waiting for network. The upload continues by itself when the connection is back.");
  for (const delay of [1940, 4000, 8000]) {
    const count = starts.length;
    await advance(delay);
    await until(() => starts.length === count + 1 && ui.queue().batch.rows[0]?.wait === "network");
    expect(live()).toStartWith("Waiting for network.");
  }
  expect(ui.said.filter((said) => said.kind === "offline")).toHaveLength(1);
  startOverride = undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transfer = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      await held;
      return transfer(input, init);
    },
    { preconnect: nativeFetch.preconnect },
  );
  window.dispatchEvent(new Event("online"));
  await until(() => ui.queue().batch.rows[0]?.wait === null);
  await advance(60);
  expect(live()).toBe("Connection is back. The upload continues.");
  expect(ui.said.filter((said) => said.kind === "online")).toHaveLength(1);
  release();
  await until(() => ui.queue().batch.phase === "done");
});

test("visibility probes only when visible and online, and a timer that fires offline is not rearmed", async () => {
  const ui = mount();
  startOverride = async () => {
    throw new TypeError("unreachable");
  };
  ui.add(file("first.txt"));
  await until(() => ui.queue().batch.rows[0]?.wait === "network");
  online = false;
  await advance(2000);
  online = true;
  await advance(120_000);
  expect(starts).toHaveLength(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(starts).toHaveLength(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.dispatchEvent(new Event("visibilitychange"));
  await until(() => starts.length === 2);
  expect(ui.said.filter((said) => said.kind === "offline")).toHaveLength(1);
  ui.dispose();
  const count = starts.length;
  await advance(600_000);
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(starts).toHaveLength(count);
});

test("retryable preparation waits without failing its group; a final preparation error still fails the group", async () => {
  const ui = mount();
  let prepares = 0;
  prepareOverride = async () => (++prepares === 1 ? Response.json({}, { status: 503 }) : Response.json({}));
  ui.queue().add(
    { baseId: "home", root: "", folders: ["Photos"], policy: "overwrite", total: 2 },
    { key: "home", label: "Home" },
    [file("first.txt"), file("next.txt")].map((file) => ({ file, path: file.name })),
  );
  await until(() => ui.queue().batch.rows[0]?.wait === "busy");
  expect(starts).toHaveLength(0);
  expect(ui.queue().batch.rows[1]!.status).toBe("pending");
  await advance(2000);
  await until(() => ui.queue().batch.phase === "done");
  expect(prepares).toBe(2);
  ui.queue().close();
  prepareOverride = async () => Response.json({ message: "No access" }, { status: 403 });
  ui.queue().add(
    { baseId: "home", root: "", folders: ["Photos"], policy: "overwrite", total: 2 },
    { key: "home", label: "Home" },
    [file("first.txt"), file("next.txt")].map((file) => ({ file, path: file.name })),
  );
  await until(() => ui.queue().batch.phase === "errors");
  expect(ui.queue().batch.rows.map((row) => row.status)).toEqual(["failed", "failed"]);
  expect(starts).toHaveLength(2);
});

test("a late attempt cannot update or settle the batch added immediately after cancellation", async () => {
  const dom = createDomTestHarness();
  let resolve!: (result: { status: "uploaded"; path: string }) => void;
  let progress!: (bytes: number) => void;
  let alive!: () => void;
  const dispose = createRoot((dispose) => {
    const queue = createUploadQueue<null>({
      reason: () => "failed",
      upload: async (_group, item, options) => {
        if (item.path === "old") {
          progress = options.onProgress;
          alive = options.alive;
          return new Promise((done) => {
            resolve = done;
          });
        }
        throw new TypeError("network");
      },
    });
    queue.add(null, { key: "home", label: "Home" }, [{ file: file("old"), path: "old" }]);
    return { queue, dispose };
  });
  cleanup = () => {
    dispose.dispose();
    dom.cleanup();
  };
  await until(() => !!resolve);
  dispose.queue.cancel();
  dispose.queue.add(null, { key: "home", label: "Home" }, [{ file: file("new"), path: "new" }]);
  progress(1);
  alive();
  resolve({ status: "uploaded", path: "old" });
  await until(() => dispose.queue.batch.rows[0]?.wait === "network");
  expect(dispose.queue.batch.rows[0]).toMatchObject({ path: "new", status: "working", sent: 0, wait: "network" });
  expect(dispose.queue.batch.done).toBe(0);
});

test.each(["network", "busy"] as const)("Cancel and dispose remove the %s wait timer and its listeners", async (kind) => {
  const dom = createDomTestHarness();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const initialTimers = jest.getTimerCount();
  const addedWindow = spyOn(window, "addEventListener");
  const removedWindow = spyOn(window, "removeEventListener");
  const addedDocument = spyOn(document, "addEventListener");
  const removedDocument = spyOn(document, "removeEventListener");
  let calls = 0;
  const { UploadTransferError } = await import("../src/upload-transfer");
  const state = createRoot((dispose) => ({
    dispose,
    queue: createUploadQueue<null>({
      reason: () => "failed",
      upload: async () => {
        calls++;
        throw new UploadTransferError("failed", kind, undefined);
      },
    }),
  }));
  cleanup = () => {
    state.dispose();
    for (const spy of [addedWindow, removedWindow, addedDocument, removedDocument]) spy.mockRestore();
    dom.cleanup();
  };
  for (const end of ["cancel", "dispose"] as const) {
    state.queue.add(null, { key: "home", label: "Home" }, [{ file: file(end), path: end }]);
    await until(() => state.queue.batch.rows[0]?.wait === kind);
    expect(jest.getTimerCount()).toBe(initialTimers + 1);
    if (end === "cancel") state.queue.cancel();
    else state.dispose();
    await flush();
    expect(jest.getTimerCount()).toBe(initialTimers);
  }
  if (kind === "network") {
    expect(addedWindow.mock.calls.filter(([type]) => type === "online")).toHaveLength(2);
    expect(removedWindow.mock.calls.filter(([type]) => type === "online")).toHaveLength(2);
    expect(addedDocument.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(2);
    expect(removedDocument.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(2);
  }
  await advance(600_000);
  expect(calls).toBe(2);
});

test.each(["alive", "progress"] as const)("a new try after a busy server stays marked retrying until progress, not on %s", async (life) => {
  const dom = createDomTestHarness();
  let calls = 0;
  let alive!: () => void;
  let progress!: (bytes: number) => void;
  const { UploadTransferError } = await import("../src/upload-transfer");
  const state = createRoot((dispose) => ({
    dispose,
    queue: createUploadQueue<null>({
      reason: () => "failed",
      upload: async (_group, _item, options) => {
        if (++calls === 1) throw new UploadTransferError("busy", "busy", undefined);
        alive = options.alive;
        progress = options.onProgress;
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }),
        );
      },
    }),
  }));
  cleanup = async () => {
    state.dispose();
    await flush();
    dom.cleanup();
  };
  state.queue.add(null, { key: "home", label: "Home" }, [{ file: file("first.txt"), path: "first.txt" }]);
  await until(() => state.queue.batch.rows[0]?.wait === "busy");
  await advance(2000);
  await until(() => calls === 2);
  expect(state.queue.batch.rows[0]!.wait).toBe("retrying");
  if (life === "alive") alive();
  else progress(1);
  expect(state.queue.batch.rows[0]!.wait).toBe(life === "alive" ? "retrying" : null);
});
