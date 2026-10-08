import { expect, test } from "bun:test";
import { type CheckDriver, runHtmlCheck } from "./check";

test.each(["context", "page"])("abort during %s creation awaits one close before discarding and rejecting", async (at) => {
  const abort = new AbortController();
  const events: string[] = [];
  let finishClose!: () => void;
  let startedClose!: () => void;
  const closing = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  const closeStarted = new Promise<void>((resolve) => {
    startedClose = resolve;
  });
  let closes = 0;
  const context = {
    close: async () => {
      closes++;
      startedClose();
      // Playwright's second close may return before its first close finishes.
      if (closes === 1) await closing;
      events.push("closed");
    },
    newPage: async () => {
      abort.abort(new Error("Check cancelled"));
      throw new Error("Page creation interrupted");
    },
  };
  const driver: CheckDriver = {
    browser: {
      browserType: () => ({ name: () => "chromium" }),
      newContext: async () => {
        if (at === "context") abort.abort(new Error("Check cancelled"));
        return context;
      },
    },
    conversationId: "chat",
    signal: abort.signal,
    start: async () => ({
      scopeId: "scope",
      hash: "a".repeat(64),
      steps: [],
      warnings: [],
      source: { entry: "index.html", files: [{ path: "index.html", content: "<h1>Check</h1>" }] },
      context: { locale: "en", timeZone: "UTC", user: null },
      theme: "light",
      assets: { prelude: "", preludeHash: "", baseCss: "" },
    }),
    initialize: async () => {
      throw new Error("Unexpected initialization");
    },
    discard: async () => {
      events.push("discarded");
    },
    save: async () => {
      throw new Error("Unexpected save");
    },
    upload: async () => {
      throw new Error("Unexpected upload");
    },
  };
  let settled = false;
  const operation = runHtmlCheck(driver).catch((error: unknown) => {
    settled = true;
    events.push("rejected");
    return error;
  });
  await closeStarted;
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(events).toEqual([]);
  finishClose();
  expect(await operation).toEqual(new Error("Check cancelled"));
  expect(closes).toBe(1);
  expect(events).toEqual(["closed", "discarded", "rejected"]);
});

test("a scope returned after cancellation is discarded without creating a context or saving files", async () => {
  const abort = new AbortController();
  const reason = new Error("Request cancelled");
  const events: string[] = [];
  const driver: CheckDriver = {
    browser: {
      browserType: () => ({ name: () => "chromium" }),
      newContext: async () => {
        events.push("context");
        throw new Error("Unexpected context");
      },
    },
    conversationId: "chat",
    signal: abort.signal,
    start: async () => {
      events.push("start");
      abort.abort(reason);
      return {
        scopeId: "scope",
        hash: "a".repeat(64),
        steps: [],
        warnings: [],
        source: { entry: "index.html", files: [{ path: "index.html", content: "<h1>Check</h1>" }] },
        context: { locale: "en", timeZone: "UTC", user: null },
        theme: "light",
        assets: { prelude: "", preludeHash: "", baseCss: "" },
      };
    },
    initialize: async () => {
      throw new Error("Unexpected initialization");
    },
    discard: async (id) => {
      events.push(`discard:${id}`);
    },
    save: async () => {
      events.push("save");
      throw new Error("Unexpected save");
    },
    upload: async () => {
      throw new Error("Unexpected upload");
    },
  };
  await expect(runHtmlCheck(driver)).rejects.toBe(reason);
  expect(events).toEqual(["start", "discard:scope"]);
});

test("diagnostic overflow records one budget error and keeps discarding both scopes", async () => {
  const discarded: string[] = [];
  const report = await runHtmlCheck({
    browser: {
      browserType: () => ({ name: () => "chromium" }),
      newContext: async () => {
        throw new Error("Browser startup failed");
      },
    },
    conversationId: "chat",
    signal: new AbortController().signal,
    start: async () => ({
      scopeId: "scope",
      hash: "a".repeat(64),
      steps: [],
      warnings: Array.from({ length: 201 }, (_, i) => `Copy warning ${i}`),
      source: { entry: "index.html", files: [{ path: "index.html", content: "<h1>Check</h1>" }] },
      context: { locale: "en", timeZone: "UTC", user: null },
      theme: "light",
      assets: { prelude: "", preludeHash: "", baseCss: "" },
    }),
    discard: async (id) => {
      discarded.push(id);
    },
    initialize: async () => {
      throw new Error("Unexpected initialization");
    },
    save: async () => {
      throw new Error("Unexpected save");
    },
    upload: async () => {
      throw new Error("Unexpected upload");
    },
  });
  expect(report.passed).toBe(false);
  expect(report.issues.length).toBeLessThanOrEqual(200);
  expect(report.issues.filter((issue) => issue.kind === "budget")).toEqual([
    { severity: "error", kind: "budget", message: "Diagnostic budget exceeded; later findings were dropped." },
  ]);
  expect(discarded).toEqual(["scope", "scope"]);
});
