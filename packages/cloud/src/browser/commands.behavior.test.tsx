import { expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { z } from "zod";
import { createDomTestHarness } from "../../../ui/test/dom";
import { type CommandOptions, commandPath } from "../contracts/commands";

if (!isServer) {
  test("without a command parameter, consumption leaves history alone and loads no contracts", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const reload = await import("./reload");
    const { consumeCommandLink } = await import("./commands");
    const load = spyOn(reload, "importOnDemand").mockResolvedValue(undefined);
    const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    try {
      for (const query of ["?filter=open", "?filter=open&command="]) {
        window.history.replaceState({ page: 2 }, "", `/app/demo${query}#details`);
        const href = window.location.href;
        await consumeCommandLink();
        expect(window.location.href).toBe(href);
        expect(window.history.state).toEqual({ page: 2 });
      }
      expect(load).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      error.mockRestore();
      dom.cleanup();
    }
  });

  test("concurrent command link consumers dispatch exactly once after loading", async () => {
    const dom = createDomTestHarness();
    const reload = await import("./reload");
    const { consumeCommandLink, registerCommandHandler } = await import("./commands");
    const pending = Promise.withResolvers<void>();
    const load = spyOn(reload, "importOnDemand").mockImplementation(async (loader) => {
      await pending.promise;
      return loader();
    });
    let calls = 0;
    const stop = registerCommandHandler("demo.edit", z.object({}), () => {
      calls++;
    });
    try {
      window.history.replaceState({ page: 2 }, "", commandPath("/app/demo?filter=open#details", "demo.edit", {}));
      const first = consumeCommandLink();
      const second = consumeCommandLink();
      expect(load).toHaveBeenCalledTimes(2);
      expect(calls).toBe(0);
      pending.resolve();
      await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect(window.location.href).toBe("http://localhost/app/demo?filter=open#details");
      expect(window.history.state).toEqual({ page: 2 });
    } finally {
      pending.resolve();
      stop();
      load.mockRestore();
      dom.cleanup();
    }
  });

  test.each([
    ["/app/demo", 0],
    ["/app/demo?filter=closed#details", 0],
    [commandPath("/app/demo?filter=closed", "demo.other", {}), 0],
    [commandPath("/app/demo?filter=closed#details", "demo.edit", {}), 1],
  ])("command consumption preserves changes made during loading: %s", async (path, expectedCalls) => {
    const dom = createDomTestHarness();
    const reload = await import("./reload");
    const { consumeCommandLink, registerCommandHandler } = await import("./commands");
    const pending = Promise.withResolvers<void>();
    const load = spyOn(reload, "importOnDemand").mockImplementation(async (loader) => {
      await pending.promise;
      return loader();
    });
    let calls = 0;
    const stops = ["demo.edit", "demo.other"].map((id) =>
      registerCommandHandler(id, z.object({}), () => {
        calls++;
      }),
    );
    try {
      window.history.replaceState(null, "", commandPath("/app/demo?filter=open", "demo.edit", {}));
      const consumption = consumeCommandLink();
      window.history.replaceState({ page: 3 }, "", path);
      const href = window.location.href;
      pending.resolve();
      await consumption;
      expect(calls).toBe(expectedCalls);
      expect(window.location.href).toBe(expectedCalls ? "http://localhost/app/demo?filter=closed#details" : href);
      expect(window.history.state).toEqual({ page: 3 });
    } finally {
      pending.resolve();
      stops.forEach((stop) => stop());
      load.mockRestore();
      dom.cleanup();
    }
  });

  test("a failed on-demand load ends openCommand without navigation or dispatch", async () => {
    const dom = createDomTestHarness();
    const reload = await import("./reload");
    const { openCommand, registerCommandHandler } = await import("./commands");
    const load = spyOn(reload, "importOnDemand").mockResolvedValue(undefined);
    const navigate = spyOn(window.location, "assign").mockImplementation(() => {});
    let handled = false;
    const stop = registerCommandHandler("demo.edit", z.object({}), () => {
      handled = true;
    });
    try {
      await openCommand("demo.edit");
      expect(load).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      expect(handled).toBe(false);
    } finally {
      stop();
      load.mockRestore();
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("an aborted openCommand ends its pending request and never navigates", async () => {
    const dom = createDomTestHarness();
    const { openCommand } = await import("./commands");
    const navigate = spyOn(window.location, "assign").mockImplementation(() => {});
    const originalFetch = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    const requested = Promise.withResolvers<void>();
    globalThis.fetch = Object.assign(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        requested.resolve();
        // Answers only through the abort, as a request the person left behind.
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason));
        });
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const controller = new AbortController();
      const opening = openCommand("demo.edit", {}, { returnTo: "/app/assistant" }, controller.signal);
      await requested.promise;
      controller.abort();
      await opening;
      expect(requestSignal?.aborted).toBe(true);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("openCommand validates options before dispatching to a local owner", async () => {
    const dom = createDomTestHarness();
    const { openCommand, registerCommandHandler } = await import("./commands");
    const navigate = spyOn(window.location, "assign").mockImplementation(() => {});
    const received: { input: unknown; options: CommandOptions }[] = [];
    const stop = registerCommandHandler("demo.edit", z.object({ id: z.string() }), (input, options) => {
      received.push({ input, options });
    });
    try {
      await openCommand("demo.edit", { id: "a", extra: "stripped" }, { returnTo: "/app/demo?filter=open" });
      expect(received).toEqual([{ input: { id: "a" }, options: { returnTo: "/app/demo?filter=open" } }]);
      await expect(openCommand("demo.edit", { id: "b" }, { returnTo: "//other.test" })).rejects.toThrow("Expected a Cloud path");
      expect(received).toHaveLength(1);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      stop();
      navigate.mockRestore();
      dom.cleanup();
    }
  });

  test("invalid and ownerless Command links are consumed without dropping page state", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const { consumeCommandLink } = await import("./commands");
    const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    try {
      window.history.replaceState({ page: 2 }, "", "/app/demo?filter=open&command=demo.edit&commandInput=invalid#details");
      await consumeCommandLink();
      expect(window.location.href).toBe("http://localhost/app/demo?filter=open#details");
      expect(window.history.state).toEqual({ page: 2 });
      expect(error).toHaveBeenCalledTimes(1);
      await consumeCommandLink();
      expect(error).toHaveBeenCalledTimes(1);
      window.history.replaceState(null, "", commandPath("/app/demo?filter=open", "demo.missing", {}));
      await consumeCommandLink();
      expect(window.location.search).toBe("?filter=open");
      expect(error).toHaveBeenCalledTimes(2);
      expect(error.mock.calls[1]?.[0]).toBe("This action is no longer available. Choose another action.");
    } finally {
      error.mockRestore();
      dom.cleanup();
    }
  });

  test("a rejecting owner produces its meaningful error once, an inline-handled failure produces no toast", async () => {
    const dom = createDomTestHarness();
    const { toast } = await import("@k2b/ui");
    const { consumeCommandLink, registerCommandHandler } = await import("./commands");
    const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    let calls = 0;
    const stop = registerCommandHandler("demo.edit", z.object({}), () => {
      calls++;
      throw new Error("The linked source is no longer available.");
    });
    const stopInline = registerCommandHandler("demo.inline", z.object({}), () => {
      calls++;
    });
    try {
      window.history.replaceState(null, "", commandPath("/app/demo", "demo.edit", {}));
      await consumeCommandLink();
      expect(calls).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[0]).toBe("The linked source is no longer available.");
      await consumeCommandLink();
      expect(calls).toBe(1);
      window.history.replaceState(null, "", commandPath("/app/demo", "demo.inline", {}));
      await consumeCommandLink();
      expect(calls).toBe(2);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stopInline();
      error.mockRestore();
      dom.cleanup();
    }
  });
}
