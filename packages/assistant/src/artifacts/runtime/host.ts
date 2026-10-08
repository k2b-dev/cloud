import { LIMITS } from "../contracts";
import type { RuntimeContext } from "./cloud";
import { cloudError } from "./errors";
import { WorkerMessage } from "./protocol";
import { sandboxDocument } from "./sandbox";
import type { WorkState } from "./work";

export const timeLimitMessage = (milliseconds: number) =>
  `The run reached the ${milliseconds / 1000}-second time limit; split the work, report progress, or use a scheduled action.`;

export type RuntimeHooks = {
  context?: RuntimeContext;
  files?: { path: string; size: number; type: string }[];
  work?: (state: WorkState) => void;
  pending?: (count: number) => void;
  log: (level: string, text: string) => void;
  error: (message: string) => void;
  output: (value: unknown) => void;
  ready: () => void;
  request: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>;
};

/** Host calls that wait on Cloud or a person; running work is not timed out meanwhile. */
const HOST_WAITS = new Set(["ai", "pdf", "http.fetch", "database", "storage", "file.read", "capabilities.run", "capabilities.stream"]);

/** Runs one script in a terminable worker inside a hidden sandbox frame. */
export function startArtifactRun(container: HTMLElement, source: { runtime: string; code: string }, hooks: RuntimeHooks) {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.hidden = true;
  frame.title = "Isolated artifact runtime";
  frame.srcdoc = sandboxDocument();
  const abort = new AbortController();
  const requests = new Map<number, AbortController>();
  let stopped = false,
    windowStart = Date.now(),
    messages = 0,
    queued = 0,
    waitingForHost = 0,
    workRunning = false;
  let chain = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  let workWatchdog: ReturnType<typeof setTimeout> | undefined;
  const post = (message: unknown) => {
    if (!stopped) frame.contentWindow?.postMessage(message, "*");
  };
  const stop = () => {
    if (stopped) return stopPromise ?? chain;
    post({ type: "stop" });
    stopped = true;
    clearTimeout(workWatchdog);
    abort.abort();
    window.removeEventListener("message", receive);
    // Give the worker one task to observe signal.abort before terminating it.
    const cleanup = new Promise<void>((resolve) =>
      setTimeout(() => {
        frame.remove();
        resolve();
      }, 50),
    );
    stopPromise = cleanup.then(() => chain);
    return stopPromise;
  };
  const armWork = () => {
    clearTimeout(workWatchdog);
    if (workRunning && !waitingForHost)
      workWatchdog = setTimeout(() => {
        hooks.error(timeLimitMessage(15000));
        void stop();
      }, 15000);
  };
  function receive(event: MessageEvent) {
    if (stopped || event.source !== frame.contentWindow) return;
    if (Date.now() - windowStart >= 1000) {
      windowStart = Date.now();
      messages = 0;
    }
    try {
      // Enforce the per-second transport budget at the host boundary.
      if (++messages > 600) throw new Error("Run exceeded message budget");
      if (event.data?.type === "bridge-ready") {
        post({
          type: "boot",
          ...source,
          context: hooks.context ?? { locale: "en-US", timeZone: "UTC", user: null },
          files: hooks.files ?? [],
        });
        return;
      }
      const encoded = JSON.stringify(event.data);
      if (!encoded || new TextEncoder().encode(encoded).byteLength > LIMITS.rpcBytes)
        throw new Error("Runtime message exceeds byte budget");
      const m = WorkerMessage.parse(event.data);
      if (m.type === "cancel") requests.get(m.id)?.abort();
      else if (m.type === "log") hooks.log(m.level, m.text);
      else if (m.type === "error") hooks.error(m.text);
      else if (m.type === "output") hooks.output(m.value);
      else if (m.type === "ready") hooks.ready();
      else if (m.type === "work") {
        workRunning = m.status === "running";
        armWork();
        const { type, ...state } = m;
        hooks.work?.(state);
      } else if (m.type === "rpc") {
        if (queued >= LIMITS.pendingRequests) throw new Error("Too many pending host requests");
        const requestAbort = new AbortController();
        requests.set(m.id, requestAbort);
        queued++;
        hooks.pending?.(queued);
        chain = chain.then(async () => {
          // Counted only once it really waits: a call cancelled while queued never paused the watchdog.
          let waits = false;
          try {
            if (stopped || requestAbort.signal.aborted) return;
            if (HOST_WAITS.has(m.method)) {
              waits = true;
              waitingForHost++;
              armWork();
            }
            const value = await hooks.request(m.method, m.args, AbortSignal.any([abort.signal, requestAbort.signal]));
            post({ type: "result", id: m.id, value });
          } catch (error) {
            const mapped = cloudError(error);
            post({ type: "result", id: m.id, error: mapped.message, code: mapped.code });
          } finally {
            if (waits) {
              waitingForHost--;
              if (!stopped) armWork();
            }
            requests.delete(m.id);
            queued--;
            hooks.pending?.(queued);
          }
        });
      }
    } catch (error) {
      hooks.error(String(error instanceof Error ? error.message : error).slice(0, LIMITS.text));
      void stop();
    }
  }
  window.addEventListener("message", receive);
  container.append(frame);
  return {
    stop,
    get stopped() {
      return stopped;
    },
  };
}
