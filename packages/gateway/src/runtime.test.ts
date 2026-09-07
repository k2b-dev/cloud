import { expect, mock, spyOn, test } from "bun:test";

// Module fixtures must not replace the real Cloud services in other suites.
if (process.env.GATEWAY_RUNTIME_TEST_CHILD !== "1") {
  test("gateway renews its presence without registry changes and drains renewal before removal", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, GATEWAY_RUNTIME_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  });
} else {
  test("idle presence survives its TTL and shutdown cannot resurrect it", async () => {
    let now = 0;
    let snapshot: { updatedAt: number; stats: { totalRequests: number } } | null = null;
    let listCalls = 0;
    let hold: Promise<void> | undefined;
    const writes: string[] = [];
    const callbacks: Array<{ run: () => void; interval: number; timer: ReturnType<typeof setInterval> }> = [];
    const interval = globalThis.setInterval;
    Object.defineProperty(globalThis, "setInterval", {
      value: (run: () => void, delay?: number) => {
        const timer = interval(run, 1_000_000);
        callbacks.push({ run, interval: delay ?? 0, timer });
        return timer;
      },
    });
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const stats = { totalRequests: 0 };
    mock.module("./stats", () => ({ stats, getRouteTable: () => ({ routeCount: 0 }), setRouteTable: () => {} }));
    mock.module("@valentinkolb/cloud", () => ({
      buildRuntimeFromRegistry: () => ({}),
      listApps: async () => {
        listCalls++;
        return [];
      },
      startProcessSync: async () => ({ stop: async () => void writes.push("sync stopped") }),
      watchAppRegistry: ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    }));
    mock.module("@valentinkolb/cloud/services", () => ({
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      buildGatewayRouteSnapshot: (input: { stats: { totalRequests: number } }) => ({
        updatedAt: now,
        stats: { totalRequests: input.stats.totalRequests },
      }),
      publishGatewayRouteSnapshot: async (value: NonNullable<typeof snapshot>) => {
        await hold;
        snapshot = value;
        writes.push("published");
      },
      removeGatewayRouteSnapshot: async () => {
        snapshot = null;
        writes.push("removed");
      },
      superviseRuntimeTask: ({ run, signal }: { run: (signal: AbortSignal) => Promise<void>; signal: AbortSignal }) => run(signal),
    }));
    const { gatewayRuntime } = await import("./runtime");
    try {
      await gatewayRuntime.setup();
      await gatewayRuntime.start();
      await gatewayRuntime.start();
      expect(callbacks).toHaveLength(1);
      const renewal = callbacks[0]!;
      expect(renewal.interval).toBeLessThan(30_000);
      stats.totalRequests = 42;
      for (now = renewal.interval; now <= 35_000; now += renewal.interval) {
        renewal.run();
        await Bun.sleep(0);
        expect(snapshot).not.toBeNull();
        expect(now - snapshot!.updatedAt).toBeLessThan(30_000);
      }
      expect(snapshot!.stats.totalRequests).toBe(42);
      expect(listCalls).toBe(1);

      const pending = Promise.withResolvers<void>();
      hold = pending.promise;
      renewal.run();
      let stopped = false;
      const stopping = gatewayRuntime.stop().then(() => {
        stopped = true;
      });
      await Bun.sleep(0);
      expect(stopped).toBe(false);
      pending.resolve();
      await stopping;
      expect(snapshot).toBeNull();
      expect(writes.slice(-3)).toEqual(["published", "removed", "sync stopped"]);
    } finally {
      for (const entry of callbacks) clearInterval(entry.timer);
      Object.defineProperty(globalThis, "setInterval", { value: interval });
      clock.mockRestore();
    }
  });
}
