// Host side of an HTML app mount in a Cloud page: frames, bridge budgets,
// reveal on ready, theme, hash mirroring, downloads, external links and the
// rule that the app goes inert while Cloud asks the person something.
import { LIMITS } from "../contracts";
import { CloudError, type CloudErrorCode, cloudError } from "../runtime/errors";
import { APPROVAL_METHODS, createServiceCalls, type RuntimeServices } from "../runtime/services";
import { type AppFiles, type ComposeOptions, composeApp, type LintIssue } from "./compose";
import { FRAME_METHODS, type FrameLogLevel, type FrameToHost, type HostToFrame } from "./protocol";
import { sanitizeSnapshot } from "./snapshot";

/** Why a mount ended: `request` is a stop by Cloud or the person; the others are budgets the app used up. */
export type StopReason = "request" | "refusals" | "flood";

/** Events of one mount. Text in `log` and `error` comes from the app; everything else is a code that the page words. */
export type MountEvent =
  | { type: "log"; level: FrameLogLevel; text: string }
  | { type: "error"; text: string; where?: string }
  /** An unhandled `cloud.*` failure the page should show outside the app. */
  | { type: "notice"; code: CloudErrorCode }
  /** The app did not report ready within `seconds`; its frame is shown anyway. */
  | { type: "not-ready"; seconds: number }
  | { type: "ready"; height: number }
  | { type: "stopped"; reason: StopReason };

/**
 * Runs one Cloud confirmation for this mount. Only one is open at a time, the
 * app frame is inert meanwhile, and the third refusal stops the app.
 */
export type Confirm = <T>(ask: () => Promise<T>, approved: (answer: T) => boolean) => Promise<T>;

export type MountOptions = Omit<ComposeOptions, "theme"> & {
  /** Server access for this mount; the mount binds app and viewer, frame arguments never choose them. */
  services: (confirm: Confirm) => RuntimeServices;
  /** Asks before an external link opens in a new tab; `signal` aborts when the app stops, which must close the question. */
  confirmOpen: (url: string, signal: AbortSignal) => Promise<boolean>;
  onEvent?: (event: MountEvent) => void;
  /** Mirrors the app's `location.hash` into the host URL. */
  onHash?: (hash: string) => void;
  /** Delivers a file to the person; the default saves it as a download. */
  onDownload?: (name: string, blob: Blob) => Promise<void> | void;
};

export const FRAME_LIMITS = {
  messagesPerSecond: 600,
  argBytes: 32 * 1024 * 1024,
  readyMs: 10_000,
  refusals: 3,
  snapshotChars: 16 * 1024 * 1024,
} as const;

/** Saves a file without ever opening app content as a document on the Cloud origin. */
export function saveDownload(name: string, blob: Blob) {
  const safe =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 180) || "download";
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safe;
  link.rel = "noopener";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Whether call arguments stay within `budget` bytes of structured data. Shared and cyclic references count once,
 * so the walk is linear in what the app sent, and it stops as soon as the budget is used up. A Blob counts as a
 * handle: the operation that reads it enforces its own byte budget (downloads, PDF inputs, capability streams).
 */
export function argumentsFit(args: unknown[], budget: number): boolean {
  const seen = new Set<object>();
  const objects: [object, number][] = [];
  let total = 0;
  /** Counts a primitive or queues an object not seen yet; false once the budget is used up. */
  const add = (value: unknown, depth: number) => {
    if (typeof value === "string") total += value.length * 2;
    else if (!value || typeof value !== "object") total += 8;
    else if (depth > 32) return false;
    else if (!seen.has(value)) {
      seen.add(value);
      objects.push([value, depth]);
    }
    return total <= budget;
  };
  if (!args.every((value) => add(value, 0))) return false;
  while (objects.length) {
    const [value, depth] = objects.pop()!;
    if (value instanceof Blob) total += 8;
    else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) total += value.byteLength;
    else if (value instanceof Map) {
      for (const [key, item] of value) if (!add(key, depth + 1) || !add(item, depth + 1)) return false;
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) if (!add(item, depth + 1)) return false;
    } else
      for (const [key, item] of Object.entries(value)) {
        total += key.length * 2;
        if (!add(item, depth + 1)) return false;
      }
    if (total > budget) return false;
  }
  return true;
}
const text = (value: unknown) => String(value).slice(0, 2000);
/** Codes of failures worth a notice; a cancelled call was stopped on purpose. */
const NOTICE_CODES = new Set<unknown>(["denied", "not_found", "invalid", "conflict", "limit", "unavailable"] satisfies CloudErrorCode[]);
const isNoticeCode = (code: unknown): code is CloudErrorCode => NOTICE_CODES.has(code);
const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");

export function mountApp(container: HTMLElement, files: AppFiles, options: MountOptions) {
  const composed = composeApp(files, { ...options, theme: theme() });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.className = "studio-app-frame";
  frame.title = options.title;
  // Opacity, not visibility: a hidden cross-process frame gets no rendering updates.
  frame.style.opacity = "0";
  frame.srcdoc = composed.wrapper;

  const lifetime = new AbortController();
  const requests = new Map<number, AbortController>();
  const app = () => frame.contentWindow?.[0] as Window | undefined;
  const post = (message: HostToFrame) => {
    if (!lifetime.signal.aborted) app()?.postMessage(message, "*");
  };
  const emit = (event: MountEvent) => options.onEvent?.(event);
  let windowStart = performance.now();
  let messages = 0;
  let ready = false;
  let asking = false;
  let refusals = 0;
  let snapshots = 0;
  const waiting = new Map<number, (html: string) => void>();

  const stop = (reason: StopReason) => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    removeEventListener("message", receive);
    themes.disconnect();
    clearTimeout(readyTimer);
    frame.remove();
    emit({ type: "stopped", reason });
  };
  const confirm: Confirm = async (ask, approved) => {
    if (asking) throw new CloudError("limit", "Another Cloud confirmation for this app is still open; wait for its answer.");
    asking = true;
    frame.inert = true;
    try {
      const answer = await ask();
      if (!approved(answer) && ++refusals >= FRAME_LIMITS.refusals) queueMicrotask(() => stop("refusals"));
      return answer;
    } finally {
      asking = false;
      frame.inert = false;
    }
  };
  const call = createServiceCalls(options.services(confirm));

  const rpc = async (id: number, method: string, args: unknown[]) => {
    const controller = new AbortController();
    requests.set(id, controller);
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    try {
      if (!FRAME_METHODS.has(method)) throw new CloudError("invalid", `Unknown cloud method ${method}`);
      if (args.length > 4 || !argumentsFit(args, FRAME_LIMITS.argBytes))
        throw new CloudError("limit", "The arguments of this call are too large.");
      let value: unknown;
      if (method === "file.save") {
        const [data, name] = args;
        if ((typeof data !== "string" && !(data instanceof Blob)) || typeof name !== "string" || !name || name.length > 180)
          throw new CloudError("invalid", "cloud.download(name, data) needs a file name of 1-180 characters and a Blob or string.");
        const blob = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
        // The same per-file budget as a script's output files.
        if (blob.size > LIMITS.inputFileBytes) throw new CloudError("limit", "A download can have at most 50 MiB.");
        await (options.onDownload ?? saveDownload)(name, blob);
        value = null;
      } else if (APPROVAL_METHODS.has(method) && asking)
        throw new CloudError("limit", "Another Cloud confirmation for this app is still open; wait for its answer.");
      else value = await call(method, args, signal);
      post({ type: "result", id, value });
    } catch (error) {
      const mapped = cloudError(error);
      post({ type: "result", id, error: mapped.message, code: mapped.code });
    } finally {
      requests.delete(id);
    }
  };

  function receive(event: MessageEvent) {
    // Only the app frame of this mount; the wrapper has no script and every other window is foreign.
    if (!app() || event.source !== app()) return;
    const now = performance.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      messages = 0;
    }
    if (++messages > FRAME_LIMITS.messagesPerSecond) return stop("flood");
    const message = event.data as FrameToHost | undefined;
    switch (message?.type) {
      case "rpc":
        if (!Number.isSafeInteger(message.id) || typeof message.method !== "string" || !Array.isArray(message.args)) return;
        // The prelude never reuses a pending id; a reused one would escape the budget below and its cancellation.
        if (requests.has(message.id)) {
          post({ type: "result", id: message.id, error: "This call id is still pending.", code: "invalid" });
          return;
        }
        if (requests.size >= LIMITS.pendingRequests) {
          post({ type: "result", id: message.id, error: "Too many cloud.* calls at once; await earlier calls first.", code: "limit" });
          return;
        }
        void rpc(message.id, message.method, message.args);
        return;
      case "cancel":
        requests.get(message.id)?.abort();
        return;
      case "ready":
        if (ready) return;
        ready = true;
        clearTimeout(readyTimer);
        frame.style.opacity = "1";
        emit({ type: "ready", height: Number.isFinite(message.height) ? message.height : 0 });
        return;
      case "hash":
        if (typeof message.value === "string" && message.value.length < 2000 && (message.value === "" || message.value.startsWith("#")))
          options.onHash?.(message.value);
        return;
      case "open":
        void openLink(message.url);
        return;
      case "log":
        emit({
          type: "log",
          level: ["log", "info", "warn", "error"].includes(message.level) ? message.level : "log",
          text: text(message.text),
        });
        return;
      case "error":
        emit({ type: "error", text: text(message.text), where: typeof message.where === "string" ? text(message.where) : undefined });
        return;
      case "notice":
        if (isNoticeCode(message.code)) emit({ type: "notice", code: message.code });
        return;
      case "snapshot":
        if (typeof message.html === "string" && message.html.length <= FRAME_LIMITS.snapshotChars) waiting.get(message.id)?.(message.html);
        waiting.delete(message.id);
        return;
    }
  }
  async function openLink(raw: unknown) {
    let url: URL;
    try {
      url = new URL(String(raw));
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      emit({ type: "log", level: "warn", text: `The link to ${text(raw)} was ignored; only http and https links open.` });
      return;
    }
    try {
      const approved = await confirm(
        () => options.confirmOpen(url.href, lifetime.signal),
        (ok) => ok,
      );
      // A question that outlived its app opens nothing.
      if (approved && !lifetime.signal.aborted) open(url.href, "_blank", "noopener,noreferrer");
    } catch (error) {
      emit({ type: "log", level: "warn", text: error instanceof Error ? error.message : String(error) });
    }
  }

  const themes = new MutationObserver(() => post({ type: "theme", value: theme() }));
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  addEventListener("message", receive);
  container.append(frame);
  const readyTimer = setTimeout(() => {
    if (ready || lifetime.signal.aborted) return;
    frame.style.opacity = "1";
    emit({ type: "not-ready", seconds: FRAME_LIMITS.readyMs / 1000 });
  }, FRAME_LIMITS.readyMs);

  return {
    frame,
    lint: composed.lint as LintIssue[],
    /** Moves the app to `hash` after the host URL changed (back and forward). */
    hash: (value: string) => post({ type: "hash", value }),
    stop: () => stop("request"),
    /** The app document as it is now, sanitized into a static copy without scripts. */
    snapshot: () =>
      new Promise<string>((resolve, reject) => {
        const id = ++snapshots;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("The app did not answer."));
        }, 5000);
        waiting.set(id, (html) => {
          clearTimeout(timer);
          resolve(sanitizeSnapshot(html));
        });
        post({ type: "snapshot", id });
      }),
  };
}
export type Mount = ReturnType<typeof mountApp>;
