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
      ui: () => {},
      log: () => {},
      error: (message) => errors.push(message),
      output: () => {},
      busy: () => {},
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

test("host stop cancels pending interactions and rejects later interactions as cancelled", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.settings.disableJavaScriptEvaluation = true;
  jest.useFakeTimers();
  const run = startArtifactRun(
    dom.root,
    { runtime: "", code: "" },
    { ui() {}, log() {}, error() {}, output() {}, busy() {}, ready() {}, request: async () => null },
  );
  try {
    const pending = run.event({ id: "button" });
    const rejection = pending.catch((error: unknown) => error);
    const stopping = run.stop();
    jest.advanceTimersByTime(50);
    await stopping;
    expect(await rejection).toMatchObject({ name: "CloudError", code: "cancelled" });
    await expect(run.event({ id: "button" })).rejects.toMatchObject({ name: "CloudError", code: "cancelled" });
  } finally {
    jest.useRealTimers();
    dom.cleanup();
  }
});
