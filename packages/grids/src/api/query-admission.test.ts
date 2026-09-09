import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import {
  createQueryAdmission,
  isQueryAdmissionError,
  queryAdmissionMiddleware,
  runWithQueryAdmission,
  runWithQueryAdmissionSignal,
} from "./query-admission";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("query admission", () => {
  test("runs at the active limit and admits queued work in FIFO order", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 1, waitTimeoutMs: 1_000 });
    const firstRelease = deferred();
    const started: string[] = [];
    const first = admission.run(async () => {
      started.push("first");
      await firstRelease.promise;
      return "first";
    });
    await Promise.resolve();

    const second = admission.run(async () => {
      started.push("second");
      return "second";
    });
    await Promise.resolve();
    const rejected = await admission.run(async () => "third");

    expect(rejected).toEqual({ ok: false, reason: "full" });
    expect(admission.stats()).toEqual({ active: 1, queued: 1 });
    firstRelease.resolve();
    expect(await first).toEqual({ ok: true, value: "first" });
    expect(await second).toEqual({ ok: true, value: "second" });
    expect(started).toEqual(["first", "second"]);
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  test("drops timed-out and aborted waiters without consuming capacity", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 2, waitTimeoutMs: 20 });
    const release = deferred();
    const active = admission.run(async () => release.promise);
    await Promise.resolve();

    expect(await admission.run(async () => undefined)).toEqual({ ok: false, reason: "timeout" });
    const controller = new AbortController();
    const aborted = admission.run(async () => undefined, controller.signal);
    controller.abort();
    expect(await aborted).toEqual({ ok: false, reason: "aborted" });

    release.resolve();
    expect((await active).ok).toBe(true);
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  test("releases capacity when admitted work throws", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 0, waitTimeoutMs: 100 });
    await expect(admission.run(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    expect(await admission.run(async () => "recovered")).toEqual({ ok: true, value: "recovered" });
  });

  test("does not start work aborted immediately after a queued grant", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 1, waitTimeoutMs: 100 });
    const release = deferred();
    const active = admission.run(async () => release.promise);
    await Promise.resolve();

    const controller = new AbortController();
    let started = false;
    const queued = admission.run(async () => {
      started = true;
    }, controller.signal);
    release.resolve();
    controller.abort();

    expect(await active).toEqual({ ok: true, value: undefined });
    expect(await queued).toEqual({ ok: false, reason: "aborted" });
    expect(started).toBe(false);
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  test("shares one admission slot between HTTP middleware and the runtime boundary", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 0, waitTimeoutMs: 100 });
    const app = new Hono<AuthContext>()
      .use("*", queryAdmissionMiddleware(admission))
      .get("/", async (c) => c.text(await runWithQueryAdmission(c, async () => "ok", admission)));

    expect((await app.request("/")).status).toBe(200);
    expect(admission.stats()).toEqual({ active: 0, queued: 0 });
  });

  test("guards direct runtime callers without HTTP middleware", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 0, waitTimeoutMs: 100 });
    const release = deferred();
    const app = new Hono<AuthContext>().get("/", async (c) => {
      try {
        return c.text(
          await runWithQueryAdmission(
            c,
            async () => {
              await release.promise;
              return "ok";
            },
            admission,
          ),
        );
      } catch (error) {
        if (isQueryAdmissionError(error)) return c.text(error.reason, 503);
        throw error;
      }
    });

    const first = app.request("/");
    await Promise.resolve();
    const rejected = await app.request("/");
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).toBe("full");
    release.resolve();
    expect((await first).status).toBe(200);
  });

  test("guards transport-neutral runtime callers with their abort signal", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 0, waitTimeoutMs: 100 });
    const release = deferred();
    const signal = new AbortController().signal;
    const first = runWithQueryAdmissionSignal(
      signal,
      async () => {
        await release.promise;
        return "ok";
      },
      admission,
    );
    await Promise.resolve();

    await expect(runWithQueryAdmissionSignal(signal, async () => "rejected", admission)).rejects.toMatchObject({ reason: "full" });
    release.resolve();
    expect(await first).toBe("ok");
  });

  test("returns a retryable 503 when request capacity is full", async () => {
    const admission = createQueryAdmission({ maxActive: 1, maxQueued: 0, waitTimeoutMs: 100 });
    const release = deferred();
    const app = new Hono().use("*", queryAdmissionMiddleware(admission)).get("/", async (c) => {
      await release.promise;
      return c.text("ok");
    });

    const first = app.request("/");
    await Promise.resolve();
    const rejected = await app.request("/");
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("Retry-After")).toBe("1");
    expect(await rejected.json()).toEqual({ message: "Grids is busy. Retry shortly." });

    release.resolve();
    expect((await first).status).toBe(200);
  });
});
