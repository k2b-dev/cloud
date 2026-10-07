import { z } from "zod";
import { LIMITS } from "../contracts";
import { createAnalyticsUi } from "./analytics-ui";
import { createBridge } from "./bridge";
import { createCloud, type RuntimeContext } from "./cloud";
import { CloudError } from "./errors";
import { ModalRequest } from "./modal-schema";
import type { UiNode } from "./protocol";

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
      "Output must be JSON data. Replace undefined values with null. Do not return UI handles, functions, or class instances. Inspect input columns before calculating derived fields.",
    );
  }
  send({ type: "output", value });
}
let nodes: UiNode[] = [];
let scheduled = false;
const bridge = createBridge(send);
const rpc = bridge.rpc;
const controller = new AbortController();
const runtimeContext: RuntimeContext = { locale: "en-US", timeZone: "UTC", user: null };
let inputFiles: { path: string; size: number; type: string }[] = [];
let booted = false;
if (!crypto.randomUUID)
  Object.defineProperty(crypto, "randomUUID", {
    value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 15) | 64;
      bytes[8] = (bytes[8]! & 63) | 128;
      const hex = [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function flushNow() {
  if (!scheduled) return;
  clearTimeout(flushTimer);
  scheduled = false;
  send({ type: "ui", nodes });
}
function flush() {
  if (scheduled) return;
  scheduled = true;
  flushTimer = setTimeout(flushNow, 100);
}
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
    // Leave transport capacity for UI/RPC. Errors remain visible; the host still
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
const analytics = createAnalyticsUi(
  (values) => {
    nodes = values;
    flush();
  },
  async ({ accept, multiple }) => {
    const result = await rpc(multiple ? "file.openMultiple" : "file.open", [{ accept }]);
    return (Array.isArray(result) ? result : [result]).flatMap((item) =>
      item && typeof item === "object" && "file" in item && item.file instanceof File ? [item.file] : [],
    );
  },
);
const ui = {
  modal: {
    confirm: (options: Omit<Extract<ModalRequest, { kind: "confirm" }>, "kind">) =>
      rpc("ui.modal", [ModalRequest.parse({ ...options, kind: "confirm" })]),
    text: (options: Omit<Extract<ModalRequest, { kind: "text" }>, "kind">) =>
      rpc("ui.modal", [ModalRequest.parse({ ...options, kind: "text" })]),
    number: (options: Omit<Extract<ModalRequest, { kind: "number" }>, "kind">) =>
      rpc("ui.modal", [ModalRequest.parse({ ...options, kind: "number" })]),
    dialog: (options: Omit<Extract<ModalRequest, { kind: "dialog" }>, "kind">) =>
      rpc("ui.modal", [ModalRequest.parse({ ...options, kind: "dialog" })]),
  },
  ...analytics.ui,
};
Object.defineProperty(globalThis, "ui", { value: Object.freeze(ui), writable: false, configurable: false });
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
globalThis.addEventListener("message", async (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "stop") {
    controller.abort();
    return;
  }
  if (m.type === "result") {
    bridge.result(m);
    return;
  }
  if (m.type === "event") {
    let failure: string | undefined;
    try {
      await analytics.event(m.id, m.event ?? { type: "change", value: null });
    } catch (error) {
      failure = textError(error).slice(0, LIMITS.text);
      send({ type: "error", text: failure });
    } finally {
      flushNow();
      if (m.requestId !== undefined) send({ type: "settled", id: m.requestId, error: failure });
    }
  }
});
globalThis.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
  send({ type: "error", text: textError(e.reason).slice(0, LIMITS.text) }),
);

Object.defineProperty(globalThis, "__artifactStart", {
  value: async (definition: Definition, input: unknown = null) => {
    if (started) return;
    started = true;
    let lastProgress: { completed: number; total?: number; label?: string } = { completed: 0 };
    try {
      if (typeof definition !== "function")
        throw new Error(
          "The entry module must default-export a function: export default () => { /* create UI or return data */ }. An exported object is not executable.",
        );
      while (!booted) await new Promise((resolve) => setTimeout(resolve, 0));
      const progress = (completed: number, total?: number, label?: string) => {
        if (!Number.isFinite(completed) || completed < 0 || (total !== undefined && (!Number.isFinite(total) || total < completed)))
          throw new CloudError("invalid", "Progress must be nonnegative and no greater than its total.");
        lastProgress = { completed, total, label: label?.slice(0, 1000) };
        send({ type: "work", status: "running", ...lastProgress });
      };
      const result = await definition(input, {
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
      controller.signal.throwIfAborted();
      send({ type: "work", status: "completed", ...lastProgress });
      if (result !== undefined) {
        try {
          sendOutput(result);
        } catch (error) {
          if (error instanceof Error && error.name === "DataCloneError")
            throw new Error(
              "Entry output must be serializable data. Do not return UI handles or functions; create the UI without returning it.",
            );
          throw error;
        }
      }
      flushNow();
      send({ type: "ready" });
    } catch (e) {
      send({ type: "work", status: controller.signal.aborted ? "cancelled" : "error", ...lastProgress });
      if (!controller.signal.aborted) send({ type: "error", text: textError(e).slice(0, LIMITS.text) });
    }
  },
});
