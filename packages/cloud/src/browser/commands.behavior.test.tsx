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
