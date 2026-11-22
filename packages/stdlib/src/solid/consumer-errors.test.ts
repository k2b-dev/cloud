import { describe, expect, it, mock, spyOn } from "bun:test";
import { catchError, createMemo, createRenderEffect } from "solid-js";
import { testRoot } from "../_test-helpers";

const render = (read: () => unknown, bad: unknown, error: Error) => {
  const view = { text: "" };
  const label = createMemo(() => {
    const value = read();
    if (value === bad) throw error;
    return String(value);
  });
  createRenderEffect(() => (view.text = label()));
  return view;
};

const captureUnhandled = async (run: () => Promise<void>) => {
  const errors: unknown[] = [];
  const listener = (error: unknown) => { errors.push(error); };
  process.on("unhandledRejection", listener);
  try {
    await run();
    await Bun.sleep(0);
    return errors;
  } finally {
    process.off("unhandledRejection", listener);
  }
};

// Bun's test runner fails on unhandled rejections even with a listener installed.
// Run these assertions outside the runner so we can observe the actual rejection.
const inBrowserProcess = async (run: () => Promise<void>) => {
  const script = `
    import { expect, mock, spyOn } from "bun:test";
    import { createMemo, createRenderEffect } from "solid-js";
    import { testRoot } from ${JSON.stringify(new URL("../_test-helpers.ts", import.meta.url).href)};
    import { query } from ${JSON.stringify(new URL("./query.ts", import.meta.url).href)};
    const render = ${render.toString()};
    const captureUnhandled = ${captureUnhandled.toString()};
    await (${run.toString()})();
  `;
  const child = Bun.spawn([process.execPath, "--conditions=browser", "-e", script], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Unhandled consumer test failed:\n${stdout}\n${stderr}`);
  }
};

const defineBrowserConsumerTests = async () => {
  // Only the browser child needs this entry point. Importing it in the parent
  // freezes hotkeys' browser detection before that suite installs its DOM mocks.
  const { clipboard, mutation, query } = await import("./index");
  describe("consumer errors", () => {
    it("query commits a snapshot without treating a consumer error as a load error", () => inBrowserProcess(async () => {
      const error = new Error("consumer render failed");
      let version = 1;
      const { result: { q, view }, dispose } = testRoot(() => {
        const q = query.create({ source: () => "/items", load: async () => `v${version}` });
        return { q, view: render(q.data, "v2", error) };
      });
      try {
        await q.refresh();
        expect(view.text).toBe("v1");
        version = 2;
        expect(await captureUnhandled(() => q.refresh())).toEqual([error]);
        expect(q.data()).toBe("v2");
        expect(q.error()).toBeNull();
        expect(q.stale()).toBe(false);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
        version = 3;
        const refresh = q.refresh();
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(true);
        await refresh;
        expect(q.data()).toBe("v3");
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    }));

    it("a first-load consumer error still leaves the next request refreshing", () => inBrowserProcess(async () => {
      const error = new Error("first render failed");
      let value = 1;
      const { result: q, dispose } = testRoot(() => {
        const q = query.create({ source: () => "/items", load: async () => value });
        render(q.data, 1, error);
        return q;
      });
      try {
        expect(await captureUnhandled(() => q.refresh())).toEqual([error]);
        expect(q.data()).toBe(1);
        expect(q.error()).toBeNull();
        expect(q.stale()).toBe(false);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
        value = 2;
        const refresh = q.refresh();
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(true);
        await refresh;
        expect(q.data()).toBe(2);
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    }));

    it("Solid catchError receives a consumer error without affecting the query", async () => {
      const error = new Error("consumer render failed");
      const handler = mock((_error: unknown) => {});
      const { result: q, dispose } = testRoot(() => {
        const q = query.create({
          source: () => "/items",
          initial: { source: "/items", data: 1 },
          load: async () => 2,
        });
        catchError(() => render(q.data, 2, error), handler);
        return q;
      });
      try {
        await q.refresh();
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(error);
        expect(q.data()).toBe(2);
        expect(q.error()).toBeNull();
        expect(q.stale()).toBe(false);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    });

    it("invalidate resolves when its snapshot commits despite a consumer error", () => inBrowserProcess(async () => {
      const error = new Error("consumer render failed");
      const { result: q, dispose } = testRoot(() => {
        const q = query.create({
          source: () => "/items",
          initial: { source: "/items", data: 1 },
          load: async () => 2,
        });
        render(q.data, 2, error);
        return q;
      });
      try {
        expect(await captureUnhandled(() => q.invalidate())).toEqual([error]);
        expect(q.data()).toBe(2);
        expect(q.error()).toBeNull();
        expect(q.stale()).toBe(false);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    }));

    it("load errors still set error and reject invalidate", async () => {
      const error = new Error("load failed");
      const { result: q, dispose } = testRoot(() => query.create({
        source: () => "/items",
        initial: { source: "/items", data: 1 },
        load: async () => { throw error; },
      }));
      try {
        await expect(q.invalidate()).rejects.toBe(error);
        expect(q.error()).toBe(error);
        expect(q.data()).toBe(1);
        expect(q.stale()).toBe(true);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    });

    it("a consumer error while showing a load error keeps the load error state", () => inBrowserProcess(async () => {
      const consumerError = new Error("error render failed");
      const loadError = new Error("load failed");
      const { result: q, dispose } = testRoot(() => {
        const q = query.create({
          source: () => "/items",
          initial: { source: "/items", data: 1 },
          load: async () => { throw loadError; },
        });
        render(() => q.error(), loadError, consumerError);
        return q;
      });
      try {
        let rejection: unknown;
        const unhandled = await captureUnhandled(async () => {
          await q.invalidate().catch((caught) => { rejection = caught; });
        });
        expect(unhandled).toEqual([consumerError]);
        expect(rejection).toBe(loadError);
        expect(q.error()).toBe(loadError);
        expect(q.data()).toBe(1);
        expect(q.stale()).toBe(true);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    }));

    it("a consumer error on refreshing does not prevent the load from starting", async () => {
      const error = new Error("refresh render failed");
      let throwOnRefresh = true;
      let value = 2;
      const load = mock(async () => {
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(true);
        return value;
      });
      const { result: q, dispose } = testRoot(() => {
        const q = query.create({
          source: () => "/items",
          initial: { source: "/items", data: 1 },
          load,
        });
        createRenderEffect(() => {
          if (q.refreshing() && throwOnRefresh) throw error;
        });
        return q;
      });
      try {
        expect(() => q.refresh()).toThrow(error);
        await Bun.sleep(0);
        expect(load).toHaveBeenCalledTimes(1);
        expect(q.data()).toBe(2);
        expect(q.error()).toBeNull();
        expect(q.stale()).toBe(false);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
        throwOnRefresh = false;
        value = 3;
        await q.refresh();
        expect(load).toHaveBeenCalledTimes(2);
        expect(q.data()).toBe(3);
      } finally {
        dispose();
      }
    });

    it("a consumer error on stale does not prevent the invalidation load", async () => {
      const error = new Error("stale render failed");
      let throwOnStale = true;
      const { result: q, dispose } = testRoot(() => {
        const q = query.create({
          source: () => "/items",
          initial: { source: "/items", data: 1 },
          load: async () => 2,
        });
        createRenderEffect(() => {
          if (q.stale() && throwOnStale) throw error;
        });
        return q;
      });
      try {
        expect(() => q.invalidate()).toThrow(error);
        throwOnStale = false;
        await Bun.sleep(0);
        expect(q.data()).toBe(2);
        expect(q.stale()).toBe(false);
        expect(q.refreshing()).toBe(false);
      } finally {
        dispose();
      }
    });

    it("a consumer error on loadingMore does not leave loadMore pending", async () => {
      const error = new Error("loadingMore render failed");
      let throwOnLoadingMore = true;
      const { result: q, dispose } = testRoot(() => {
        const q = query.createInfinite<string, number, number>({
          source: () => "/items",
          initial: { source: "/items", pages: [1] },
          loadPage: async (_source, { cursor }) => cursor ?? 1,
          getNextCursor: (page) => page < 3 ? page + 1 : null,
        });
        createRenderEffect(() => {
          if (q.loadingMore() && throwOnLoadingMore) throw error;
        });
        return q;
      });
      try {
        expect(() => q.loadMore()).toThrow(error);
        throwOnLoadingMore = false;
        await Bun.sleep(0);
        expect(q.pages()).toEqual([1, 2]);
        expect(q.loadingMore()).toBe(false);
        expect(q.error()).toBeNull();
        await q.loadMore();
        expect(q.pages()).toEqual([1, 2, 3]);
      } finally {
        dispose();
      }
    });

    it("loadMore commits pages and settles before a consumer error surfaces", () => inBrowserProcess(async () => {
      const error = new Error("pages render failed");
      const { result: q, dispose } = testRoot(() => {
        const q = query.createInfinite<string, number, number>({
          source: () => "/items",
          loadPage: async (_source, { cursor }) => cursor ?? 1,
          getNextCursor: (page) => page < 3 ? page + 1 : null,
        });
        render(() => q.pages().length, 2, error);
        return q;
      });
      try {
        await q.refresh();
        expect(q.hasMore()).toBe(true);
        expect(await captureUnhandled(() => q.loadMore())).toEqual([error]);
        expect(q.pages()).toEqual([1, 2]);
        expect(q.error()).toBeNull();
        expect(q.loadingMore()).toBe(false);
        expect(q.stale()).toBe(false);
        expect(q.loading()).toBe(false);
        expect(q.refreshing()).toBe(false);
        expect(q.hasMore()).toBe(true);
        await q.loadMore();
        expect(q.pages()).toEqual([1, 2, 3]);
        expect(q.loadingMore()).toBe(false);
        expect(q.hasMore()).toBe(false);
      } finally {
        dispose();
      }
    }));

    it("getNextCursor errors during loadMore remain load errors", async () => {
      const error = new Error("cursor failed");
      const { result: q, dispose } = testRoot(() => query.createInfinite<string, number, number>({
        source: () => "/items",
        initial: { source: "/items", pages: [1] },
        loadPage: async (_source, { cursor }) => cursor ?? 1,
        getNextCursor: (page) => {
          if (page === 2) throw error;
          return page + 1;
        },
      }));
      try {
        await q.loadMore();
        expect(q.error()).toBe(error);
        expect(q.pages()).toEqual([1]);
        expect(q.loadingMore()).toBe(false);
        expect(q.hasMore()).toBe(true);
      } finally {
        dispose();
      }
    });

    it("mutate rejects consumer errors without calling onError", async () => {
      const error = new Error("mutation render failed");
      const onError = mock((_error: Error) => {});
      const onSuccess = mock(() => {});
      const onFinally = mock(() => { expect(m.loading()).toBe(false); });
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({
          mutation: async (value: string) => value,
          onError,
          onSuccess,
          onFinally,
        });
        render(m.data, "saved", error);
        return m;
      });
      try {
        await expect(m.mutate("saved")).rejects.toBe(error);
        expect(m.data()).toBe("saved");
        expect(m.error()).toBeNull();
        expect(m.loading()).toBe(false);
        expect(onError).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onFinally).toHaveBeenCalledTimes(1);
      } finally {
        dispose();
      }
    });

    it("a consumer error when loading starts rejects mutate before the mutation runs", async () => {
      const error = new Error("loading render failed");
      let throwOnLoading = true;
      const run = mock(async (value: string) => value);
      const onFinally = mock(() => {});
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({ mutation: run, onFinally });
        createRenderEffect(() => {
          if (m.loading() && throwOnLoading) throw error;
        });
        return m;
      });
      try {
        await expect(m.mutate("saved")).rejects.toBe(error);
        expect(run).not.toHaveBeenCalled();
        expect(m.loading()).toBe(false);
        expect(m.error()).toBeNull();
        expect(onFinally).toHaveBeenCalledTimes(1);
        throwOnLoading = false;
        await m.mutate("saved");
        expect(m.data()).toBe("saved");
      } finally {
        dispose();
      }
    });

    it("Solid catchError receives a mutation consumer error and mutate resolves", async () => {
      const error = new Error("mutation render failed");
      const handler = mock((_error: unknown) => {});
      const onError = mock((_error: Error) => {});
      const { result: m, dispose } = testRoot(() => {
        const m = mutation.create({ mutation: async (value: string) => value, onError });
        catchError(() => render(m.data, "saved", error), handler);
        return m;
      });
      try {
        await expect(m.mutate("saved")).resolves.toBe("success");
        expect(handler).toHaveBeenCalledWith(error);
        expect(m.data()).toBe("saved");
        expect(m.error()).toBeNull();
        expect(m.loading()).toBe(false);
        expect(onError).not.toHaveBeenCalled();
      } finally {
        dispose();
      }
    });

    it("mutate and retry reject onSuccess errors without calling onError", async () => {
      const error = new Error("onSuccess failed");
      const onError = mock((_error: Error) => {});
      const onFinally = mock(() => { expect(m.loading()).toBe(false); });
      const m = mutation.create({
        mutation: async (value: string) => value,
        onSuccess: () => { throw error; },
        onError,
        onFinally,
      });
      await expect(m.mutate("saved")).rejects.toBe(error);
      expect(m.data()).toBe("saved");
      expect(m.error()).toBeNull();
      expect(m.loading()).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      expect(onFinally).toHaveBeenCalledTimes(1);
      await expect(m.retry()).rejects.toBe(error);
      expect(m.error()).toBeNull();
      expect(m.loading()).toBe(false);
      expect(onError).not.toHaveBeenCalled();
      expect(onFinally).toHaveBeenCalledTimes(2);
    });

    it("mutation function errors still set error and call onError without rejecting", async () => {
      const error = new Error("mutation failed");
      const onError = mock((_error: Error) => {});
      const onFinally = mock(() => { expect(m.loading()).toBe(false); });
      const m = mutation.create({
        mutation: async () => { throw error; },
        onError,
        onFinally,
      });
      await expect(m.mutate(undefined)).resolves.toBe("error");
      expect(m.error()).toBe(error);
      expect(m.loading()).toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(error, expect.anything(), { retry: expect.any(Function) });
      expect(onFinally).toHaveBeenCalledTimes(1);
    });

    it("onAbort errors for returned aborted results reject without calling onAbort twice", async () => {
      const error = new Error("onAbort failed");
      let resolve!: (value: string) => void;
      const onAbort = mock(() => { throw error; });
      const onError = mock((_error: Error) => {});
      const onFinally = mock(() => { expect(m.loading()).toBe(false); });
      const m = mutation.create({
        mutation: () => new Promise<string>((nextResolve) => { resolve = nextResolve; }),
        onAbort,
        onError,
        onFinally,
      });
      const pending = m.mutate(undefined);
      m.abort();
      resolve("saved");
      await expect(pending).rejects.toBe(error);
      expect(m.data()).toBeNull();
      expect(m.error()).toBeNull();
      expect(m.loading()).toBe(false);
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(onFinally).toHaveBeenCalledTimes(1);
    });

    it("clipboard.create rejects consumer feedback errors and still resets feedback", async () => {
      const error = new Error("clipboard render failed");
      const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      const writeText = mock(async (_text: string) => {});
      Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: { writeText } },
        configurable: true,
      });
      const logged = spyOn(console, "error").mockImplementation(() => {});
      const { result: c, dispose } = testRoot(() => {
        const c = clipboard.create(10);
        render(c.wasCopied, true, error);
        return c;
      });
      try {
        await expect(c.copy("hello")).rejects.toBe(error);
        expect(writeText).toHaveBeenCalledWith("hello");
        expect(logged).not.toHaveBeenCalled();
        expect(c.wasCopied()).toBe(true);
        await Bun.sleep(30);
        expect(c.wasCopied()).toBe(false);
      } finally {
        dispose();
        logged.mockRestore();
        if (navigatorDescriptor) {
          Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
          Reflect.deleteProperty(globalThis, "navigator");
        }
      }
    });

    it("clipboard.createWriter rejects consumer feedback errors without setting error", async () => {
      const error = new Error("clipboard render failed");
      const write = mock(async (_text: string) => {});
      const logged = spyOn(console, "error").mockImplementation(() => {});
      const { result: c, dispose } = testRoot(() => {
        const c = clipboard.createWriter({ write, copiedFor: 10 });
        render(c.wasCopied, true, error);
        return c;
      });
      try {
        await expect(c.copy("hello")).rejects.toBe(error);
        expect(write).toHaveBeenCalledWith("hello");
        expect(logged).not.toHaveBeenCalled();
        expect(c.error()).toBeNull();
        expect(c.wasCopied()).toBe(true);
        await Bun.sleep(30);
        expect(c.wasCopied()).toBe(false);
      } finally {
        dispose();
        logged.mockRestore();
      }
    });
  });
};

if (process.env.STDLIB_SOLID_BROWSER_TESTS === "1") {
  await defineBrowserConsumerTests();
} else {
  describe("consumer errors browser suite", () => {
    it("passes with SolidJS browser conditions", async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--conditions=browser",
          import.meta.path,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            STDLIB_SOLID_BROWSER_TESTS: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Consumer browser tests failed:\n${stdout}\n${stderr}`);
      }
    });
  });
}
