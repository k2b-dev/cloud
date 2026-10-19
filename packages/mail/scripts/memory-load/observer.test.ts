import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { observerSource } from "./runner";

test("RSS observer samples while the main thread is blocked and reports the tick gap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mail-memory-observer-"));
  const file = join(dir, "samples.ndjson");
  const url = URL.createObjectURL(new Blob([observerSource], { type: "text/javascript" }));
  const worker = new Worker(url);
  let readyResolve: () => void = () => undefined;
  let doneResolve: (value: unknown) => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  const done = new Promise<unknown>((resolve) => {
    doneResolve = resolve;
  });
  const messageSchema = z.object({ type: z.string(), result: z.unknown().optional() });
  worker.onmessage = (event: MessageEvent<unknown>) => {
    const data = messageSchema.parse(event.data);
    if (data.type === "ready") readyResolve();
    if (data.type === "done") doneResolve(data.result);
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const failure = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Observer test timed out")), 5000);
    worker.onerror = (event) => reject(new Error(event.message));
  });
  try {
    await Promise.race([ready, failure]);
    worker.postMessage({ type: "start", file, baseline: process.memoryUsage().rss, threshold: 0 });
    await Bun.sleep(60);
    worker.postMessage({ type: "tick" });
    await Bun.sleep(20);
    const blockedAt = Date.now();
    Bun.sleepSync(200);
    const releasedAt = Date.now();
    worker.postMessage({ type: "stop" });
    const result = z
      .object({ peakRss: z.number(), peakAt: z.number(), longestStallMs: z.number(), samples: z.number() })
      .parse(await Promise.race([done, failure]));
    const samples = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => z.object({ kind: z.literal("rss"), at: z.number(), rss: z.number() }).parse(JSON.parse(line)));
    expect(samples.length).toBe(result.samples);
    expect(samples.some((s) => s.at > blockedAt && s.at < releasedAt)).toBe(true);
    expect(result.peakRss).toBe(Math.max(...samples.map((s) => s.rss)));
    expect(result.longestStallMs).toBeGreaterThanOrEqual(180);
  } finally {
    clearTimeout(timeout);
    worker.terminate();
    URL.revokeObjectURL(url);
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
