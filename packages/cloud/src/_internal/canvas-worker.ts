import { fileURLToPath } from "node:url";

/**
 * Starts a native worker (PDF pages, app icons, print images) in a process of its own. RLIMIT_DATA bounds the decoder heap
 * and native writable mappings on Linux. Positional arguments keep paths out of shell code; no elevated privileges.
 * The caller owns the deadline and kills the process on abort.
 */
export const spawnCanvasWorker = (worker: URL, name: string, input: string | Blob, cpuSeconds?: number) => {
  if (cpuSeconds !== undefined && (!Number.isSafeInteger(cpuSeconds) || cpuSeconds < 1)) throw new Error("Invalid canvas CPU budget");
  const child = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      'ulimit -d 524288 || exit 70; if [ -n "$1" ]; then ulimit -t "$1" || exit 70; fi; shift; exec "$@"',
      name,
      cpuSeconds?.toString() ?? "",
      process.execPath,
      "--no-env-file",
      fileURLToPath(worker),
    ],
    {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      // No application credentials or configuration reach the decoder, only fixed
      // runtime settings: the Bun work pool, canvas tokio runtime, and JSC GC
      // markers otherwise grow with the host's cores, and RLIMIT_DATA also counts
      // each thread's stack and allocator memory.
      // Bun's allocator otherwise commits whole arenas up front, which RLIMIT_DATA counts as used.
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        UV_THREADPOOL_SIZE: "2",
        TOKIO_WORKER_THREADS: "2",
        BUN_JSC_numberOfGCMarkers: "2",
        MIMALLOC_ARENA_EAGER_COMMIT: "0",
      },
    },
  );
  // Drain even after the diagnostic cap, so a noisy decoder cannot block on its stderr pipe.
  const diagnostics = (async () => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of child.stderr) {
      const kept = chunk.subarray(0, Math.max(0, 16 * 1024 - bytes));
      if (kept.byteLength) chunks.push(kept);
      bytes += kept.byteLength;
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  })();
  return Object.assign(child, { diagnostics });
};
