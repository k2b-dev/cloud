import { fileURLToPath } from "node:url";

/**
 * Starts a native canvas worker (PDF pages, app icons) in a process of its own. RLIMIT_DATA bounds the decoder heap
 * and native writable mappings on Linux. Positional arguments keep paths out of shell code; no elevated privileges.
 * The caller owns the deadline and kills the process on abort.
 */
export const spawnCanvasWorker = (worker: URL, name: string, input: string) =>
  Bun.spawn(["/bin/sh", "-c", 'ulimit -d 524288 || exit 70; exec "$@"', name, process.execPath, "--no-env-file", fileURLToPath(worker)], {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
    // No application credentials or configuration reach the decoder, only fixed
    // thread pool sizes: the Bun work pool, canvas tokio runtime, and JSC GC
    // markers otherwise grow with the host's cores, and RLIMIT_DATA also counts
    // each thread's stack and allocator memory.
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      UV_THREADPOOL_SIZE: "2",
      TOKIO_WORKER_THREADS: "2",
      BUN_JSC_numberOfGCMarkers: "2",
    },
  });
