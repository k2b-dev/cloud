import { z } from "zod";
import { LIMITS } from "../contracts";
import { createBridge } from "./bridge";
import { createCloud, type RuntimeContext } from "./cloud";
import { CloudError } from "./errors";
import { ensureRandomUuid } from "./random-uuid";

type Definition = (
  input: unknown,
  context: {
    files: { path: string; size: number; type: string; file: () => Promise<File> }[];
    signal: AbortSignal;
    progress: (completed: number, total?: number, label?: string) => void;
  },
) => unknown;
const send = globalThis.postMessage.bind(globalThis);
function sendOutput(value: unknown) {
  if (!z.json().safeParse(value).success) {
    throw new Error(
      "Output must be JSON data. Replace undefined values with null. Do not return functions or class instances. Inspect input columns before calculating derived fields.",
    );
  }
  send({ type: "output", value });
}
const bridge = createBridge(send);
const rpc = bridge.rpc;
const controller = new AbortController();
const runtimeContext: RuntimeContext = { locale: "en-US", timeZone: "UTC", user: null };
let inputFiles: { path: string; size: number; type: string }[] = [];
let booted = false;
ensureRandomUuid();
const textError = (e: unknown) => (e instanceof z.ZodError ? z.prettifyError(e) : e instanceof Error ? (e.stack ?? e.message) : String(e));
let logWindow = Date.now(),
  logCount = 0,
  suppressedLogs = 0;
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    if (Date.now() - logWindow >= 1000) {
      logWindow = Date.now();
      logCount = 0;
      if (suppressedLogs) {
        send({ type: "log", level: "warn", text: `Suppressed ${suppressedLogs} repetitive log messages` });
        suppressedLogs = 0;
      }
    }
    // Leave transport capacity for RPC. Errors remain visible; the host still
    // terminates a malicious stream that exceeds its overall message budget.
    if (level !== "error" && logCount++ >= LIMITS.logs) {
      suppressedLogs++;
      return;
    }
    const seen = new WeakSet();
    let text = "";
    try {
      text = args
        .map((a) =>
          typeof a === "string"
            ? a
            : JSON.stringify(a, (_k, v) => {
                if (v && typeof v === "object") {
                  if (seen.has(v)) return "[Circular]";
                  seen.add(v);
                }
                return typeof v === "bigint" ? String(v) : v;
              }),
        )
        .join(" ");
    } catch {
      text = "[Unserializable log]";
    }
    send({ type: "log", level, text: text.slice(0, LIMITS.text) });
  };
}
Object.defineProperty(globalThis, "__artifactInit", {
  value: (context: RuntimeContext, files: typeof inputFiles) => {
    if (booted) return;
    booted = true;
    Object.assign(runtimeContext, context);
    inputFiles = files;
    Object.defineProperty(globalThis, "cloud", { value: createCloud(rpc, runtimeContext), writable: false, configurable: false });
  },
});
let started = false;
globalThis.addEventListener("message", (event: MessageEvent) => {
  // Only the sandbox frame that created this dedicated worker can post to it; such messages have no source.
  if (event.source) return;
  const m = event.data;
  if (m.type === "stop") controller.abort();
  else if (m.type === "result") bridge.result(m);
});
globalThis.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
  send({ type: "error", text: textError(e.reason).slice(0, LIMITS.text) }),
);

Object.defineProperty(globalThis, "__artifactStart", {
  value: async (definition: Definition, input: unknown = null) => {
    if (started) return;
    started = true;
    let entryRunning = true;
    let lastProgress: { completed: number; total?: number; label?: string } = { completed: 0 };
    try {
      if (typeof definition !== "function")
        throw new Error(
          "The entry module must default-export a function: export default (input, { files, signal, progress }) => result. An exported object is not executable.",
        );
      while (!booted) await new Promise((resolve) => setTimeout(resolve, 0));
      const progress = (completed: number, total?: number, label?: string) => {
        if (!entryRunning) throw new CloudError("invalid", "Progress is only available while the entry function runs.");
        if (!Number.isFinite(completed) || completed < 0 || (total !== undefined && (!Number.isFinite(total) || total < completed)))
          throw new CloudError("invalid", "Progress must be nonnegative and no greater than its total.");
        lastProgress = { completed, total, label: label?.slice(0, 1000) };
        send({ type: "work", status: "running", ...lastProgress });
      };
      let result: unknown;
      try {
        result = await definition(input, {
          signal: controller.signal,
          progress,
          files: inputFiles.map((file) => ({
            ...file,
            file: async () => {
              const result = await rpc("file.read", [file.path], controller.signal);
              if (!result || typeof result !== "object" || !("file" in result) || !(result.file instanceof File))
                throw new CloudError("not_found", "The input file is unavailable.");
              return result.file;
            },
          })),
        });
      } finally {
        entryRunning = false;
      }
      controller.signal.throwIfAborted();
      send({ type: "work", status: "completed", ...lastProgress });
      if (result !== undefined) {
        try {
          sendOutput(result);
        } catch (error) {
          if (error instanceof Error && error.name === "DataCloneError")
            throw new Error("Entry output must be serializable data. Do not return functions or class instances.");
          throw error;
        }
      }
      send({ type: "ready" });
    } catch (e) {
      entryRunning = false;
      send({ type: "work", status: controller.signal.aborted ? "cancelled" : "error", ...lastProgress });
      if (!controller.signal.aborted) send({ type: "error", text: textError(e).slice(0, LIMITS.text) });
    }
  },
});
