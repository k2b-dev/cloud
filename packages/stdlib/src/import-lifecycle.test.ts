import { describe, it } from "bun:test";
import { fileURLToPath } from "node:url";

type ProbeResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const runProbe = async (
  script: string,
  timeoutMs = 2_000,
): Promise<ProbeResult> => {
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: null; timedOut: true }>((resolve) => {
      timeout = setTimeout(
        () => resolve({ exitCode: null, timedOut: true }),
        timeoutMs,
      );
    }),
  ]);

  if (timeout) clearTimeout(timeout);
  if (outcome.timedOut) {
    child.kill();
    await child.exited;
  }

  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { ...outcome, stdout, stderr };
};

const assertProbeSucceeded = (result: ProbeResult): void => {
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `Probe failed: ${JSON.stringify(result, null, 2)}`,
    );
  }
};

describe("public entry point lifecycle", () => {
  for (const entryPoint of [
    "@k2b/stdlib",
    "@k2b/stdlib/qr",
    "@k2b/stdlib/browser",
    "@k2b/stdlib/solid",
    "@k2b/stdlib/bun",
  ]) {
    it(`${entryPoint} exits after import`, async () => {
      const result = await runProbe(`await import(${JSON.stringify(entryPoint)});`);
      assertProbeSucceeded(result);
    });
  }
});

describe("localStore BroadcastChannel lifecycle", () => {
  it("creates one channel lazily and preserves cross-tab sync", async () => {
    const result = await runProbe(`
      let constructions = 0;
      let listenerRegistrations = 0;
      const broadcasts = [];

      class MockBroadcastChannel {
        static messageListener = null;

        constructor(name) {
          if (name !== "localstorage-sync") throw new Error("Unexpected channel name");
          constructions++;
        }

        addEventListener(type, listener) {
          if (type !== "message") return;
          listenerRegistrations++;
          MockBroadcastChannel.messageListener = listener;
        }

        postMessage(message) {
          broadcasts.push(message);
        }
      }

      Object.defineProperty(globalThis, "window", {
        value: globalThis,
        configurable: true,
      });
      Object.defineProperty(globalThis, "BroadcastChannel", {
        value: MockBroadcastChannel,
        configurable: true,
      });

      const { localStore } = await import("@k2b/stdlib/solid");
      if (constructions !== 0) {
        throw new Error("Import constructed a BroadcastChannel");
      }

      const values = new Map();
      const storage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      };
      const { createRoot } = await import("solid-js");

      let first;
      let setFirst;
      let disposeFirst;
      createRoot((dispose) => {
        disposeFirst = dispose;
        [first, setFirst] = localStore.create(
          "first",
          { count: 0 },
          { storage },
        );
      });

      let disposeSecond;
      createRoot((dispose) => {
        disposeSecond = dispose;
        localStore.create("second", { count: 0 }, { storage });
      });

      if (constructions !== 1 || listenerRegistrations !== 1) {
        throw new Error(
          "Expected one shared channel/listener, got " +
            constructions + "/" + listenerRegistrations,
        );
      }

      values.set("first", JSON.stringify({ count: 7, _key: "first" }));
      MockBroadcastChannel.messageListener?.({
        data: { key: "first" },
      });
      if (first.count !== 7) {
        throw new Error("Cross-tab message did not refresh the store");
      }

      setFirst("count", 8);
      await Bun.sleep(10);
      if (broadcasts.length !== 1 || broadcasts[0].key !== "first") {
        throw new Error("Local update was not broadcast exactly once");
      }

      disposeFirst();
      disposeSecond();
    `);

    assertProbeSucceeded(result);
  });
});
