import { expect, jest, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { startArtifactRun } from "./host";

test("progress watchdog pauses during host approval and resumes with an actionable time-limit error", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.settings.disableJavaScriptEvaluation = true;
  const errors: string[] = [];
  const effect = Promise.withResolvers<unknown>();
  jest.useFakeTimers();
  const run = startArtifactRun(
    dom.root,
    { runtime: "", code: "" },
    {
      log: () => {},
      error: (message) => errors.push(message),
      output: () => {},
      ready: () => {},
      request: () => effect.promise,
    },
  );
  const frame = dom.window.document.querySelector("iframe")!;
  const message = (data: unknown) => {
    const event = new dom.window.MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    dom.window.dispatchEvent(event);
  };
  try {
    message({ type: "work", status: "running", completed: 1, total: 2 });
    message({ type: "rpc", id: 0, method: "http.fetch", args: [] });
    await Promise.resolve();
    // Human approval may take longer than the 15-second worker budget.
    jest.advanceTimersByTime(60000);
    expect(errors).toEqual([]);
    expect(run.stopped).toBe(false);
    effect.resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(15000);
    expect(errors).toEqual([expect.stringContaining("15-second time limit; split the work, report progress, or use a scheduled action")]);
    expect(run.stopped).toBe(true);
    jest.advanceTimersByTime(50);
    await run.stop();
  } finally {
    effect.resolve(null);
    jest.useRealTimers();
    dom.cleanup();
  }
});

test("host stop aborts pending host requests", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.settings.disableJavaScriptEvaluation = true;
  jest.useFakeTimers();
  const aborted = Promise.withResolvers<boolean>();
  const run = startArtifactRun(
    dom.root,
    { runtime: "", code: "" },
    {
      log() {},
      error() {},
      output() {},
      ready() {},
      request: (_method, _args, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted.resolve(true);
            reject(new Error("aborted"));
          }),
        ),
    },
  );
  const frame = dom.window.document.querySelector("iframe")!;
  const event = new dom.window.MessageEvent("message", { data: { type: "rpc", id: 0, method: "database", args: [] } });
  Object.defineProperty(event, "source", { value: frame.contentWindow });
  try {
    dom.window.dispatchEvent(event);
    await Promise.resolve();
    const stopping = run.stop();
    jest.advanceTimersByTime(50);
    expect(await aborted.promise).toBe(true);
    await stopping;
    expect(run.stopped).toBe(true);
  } finally {
    jest.useRealTimers();
    dom.cleanup();
  }
});

test("a call cancelled while queued does not switch off the watchdog", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.settings.disableJavaScriptEvaluation = true;
  const errors: string[] = [];
  const first = Promise.withResolvers<unknown>();
  jest.useFakeTimers();
  const run = startArtifactRun(
    dom.root,
    { runtime: "", code: "" },
    { log: () => {}, error: (message) => errors.push(message), output: () => {}, ready: () => {}, request: () => first.promise },
  );
  const frame = dom.window.document.querySelector("iframe")!;
  const message = (data: unknown) => {
    const event = new dom.window.MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: frame.contentWindow });
    dom.window.dispatchEvent(event);
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  try {
    message({ type: "work", status: "running", completed: 0, total: 1 });
    message({ type: "rpc", id: 0, method: "ai", args: [] });
    message({ type: "rpc", id: 1, method: "ai", args: [] });
    // The second call is cancelled while the first one still holds the queue.
    message({ type: "cancel", id: 1 });
    await settle();
    first.resolve(null);
    await settle();
    // Synchronous work after both calls is still stopped at the time limit.
    jest.advanceTimersByTime(15000);
    expect(errors).toEqual([expect.stringContaining("15-second time limit")]);
    expect(run.stopped).toBe(true);
    jest.advanceTimersByTime(50);
    await run.stop();
  } finally {
    first.resolve(null);
    jest.useRealTimers();
    dom.cleanup();
  }
});
