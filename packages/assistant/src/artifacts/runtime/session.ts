import { LIMITS } from "../contracts";
import type { RuntimeContext } from "./cloud";
import { CloudError } from "./errors";
import { startArtifactRun, timeLimitMessage } from "./host";
import { APPROVAL_METHODS, createServiceCalls, type RuntimeServices } from "./services";
import type { WorkState } from "./work";

export type RunLog = { time: string; level: string; text: string };
export type RunSnapshot = {
  status: "starting" | "ready" | "stopped" | "error";
  work?: WorkState;
  approvalPending?: boolean;
  inputPending?: boolean;
  pendingRequests?: number;
  logs: RunLog[];
  output?: unknown;
  error?: string;
  files: { name: string; size: number; type: string }[];
};
export type SessionOptions = RuntimeServices & {
  context?: RuntimeContext;
  changed: (snapshot: RunSnapshot) => void;
  inputs?: File[];
  inputFiles?: { name: string; size: number; type: string }[];
  readInput?: (name: string, signal: AbortSignal) => Promise<File>;
};

/** One script run owns its effects and state. Its downloads are captured as output files for `code_export`. */
export function createArtifactSession(
  container: HTMLElement,
  source: { runtime: string; code: string; context?: RuntimeContext },
  options: SessionOptions,
) {
  let state: RunSnapshot = { status: "starting", logs: [], files: [] };
  const inputs = options.inputs ?? [];
  const inputFiles =
    options.inputFiles ?? inputs.map((file) => ({ name: file.webkitRelativePath || file.name, size: file.size, type: file.type }));
  if (
    inputFiles.length > LIMITS.files ||
    inputFiles.some((file) => file.size > LIMITS.inputFileBytes) ||
    inputFiles.reduce((size, file) => size + file.size, 0) > LIMITS.inputBytes
  )
    throw new Error("Selected inputs exceed the chat-file budget (50 MiB per file, 250 MiB total, 64 selected paths)");
  if (new Set(inputFiles.map((file) => file.name)).size !== inputFiles.length) throw new Error("Input paths must be unique");
  const outputFiles = new Map<string, File>();
  const call = createServiceCalls(options);
  let approvals = 0;
  let waits = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const emit = (patch: Partial<RunSnapshot>) => {
    state = { ...state, ...patch };
    options.changed(state);
  };
  const log = (level: string, text: string) =>
    emit({ logs: [...state.logs, { time: new Date().toISOString(), level, text }].slice(-LIMITS.logs) });
  // The start watchdog stops a script that neither finishes nor reports progress, but never while it waits on Cloud.
  const arm = () => {
    clearTimeout(watchdog);
    if (state.status !== "starting" || state.work?.status === "running" || approvals || waits) return;
    watchdog = setTimeout(() => {
      emit({ status: "error", error: timeLimitMessage(15000) });
      void run.stop();
    }, 15000);
  };
  /** Marks a host call as pending for the agent's inspection while it runs. */
  const waiting = async <T>(approval: boolean, work: () => Promise<T>) => {
    clearTimeout(watchdog);
    if (approval) approvals++;
    else waits++;
    emit({ approvalPending: approvals > 0, inputPending: waits > 0 });
    try {
      return await work();
    } finally {
      if (approval) approvals--;
      else waits--;
      emit({ approvalPending: approvals > 0, inputPending: waits > 0 });
      arm();
    }
  };
  const run = startArtifactRun(container, source, {
    context: source.context ?? options.context,
    files: inputFiles.map(({ name, ...file }) => ({ path: name, ...file })),
    pending: (pendingRequests) => emit({ pendingRequests }),
    work: (work) => {
      emit({ work });
      arm();
    },
    log,
    output: (output) => emit({ output }),
    error: (error) => {
      const initial = state.status === "starting";
      clearTimeout(watchdog);
      emit({ status: "error", error });
      log("error", error);
      if (initial) void run.stop();
    },
    ready: () => {
      clearTimeout(watchdog);
      emit({ status: "ready" });
    },
    request: async (method, args, signal) => {
      if (method === "file.read") {
        if (typeof args[0] !== "string" || !inputFiles.some((file) => file.name === args[0]))
          throw new CloudError("not_found", "Input file not found; use the script context files first");
        const path = args[0];
        const file = await waiting(false, async () =>
          options.readInput ? options.readInput(path, signal) : inputs.find((file) => (file.webkitRelativePath || file.name) === path),
        );
        if (!file) throw new CloudError("not_found", "Input file not found");
        return { file, path: file.webkitRelativePath || file.name };
      }
      if (method === "file.save") {
        const [data, name] = args;
        if (
          (typeof data !== "string" && !(data instanceof Blob)) ||
          typeof name !== "string" ||
          !name ||
          name.length > 180 ||
          /[/\\\x00]/.test(name)
        )
          throw new CloudError("invalid", "Download names must have 1-180 characters and contain no /, backslash, or NUL.");
        const file = new File([data], name, { type: data instanceof Blob ? data.type : "text/plain" });
        const total = [...outputFiles.values()].reduce((size, item) => size + (item.name === name ? 0 : item.size), file.size);
        if (file.size > LIMITS.inputFileBytes || total > LIMITS.inputBytes || (!outputFiles.has(name) && outputFiles.size >= LIMITS.files))
          throw new CloudError("limit", "Output files exceed the run budget");
        outputFiles.set(name, file);
        emit({ files: [...outputFiles.values()].map((file) => ({ name: file.name, size: file.size, type: file.type })) });
        return null;
      }
      if (method === "runtime.chunk") return call(method, args, signal);
      return waiting(APPROVAL_METHODS.has(method), () => call(method, args, signal));
    },
  });
  log("info", "Started");
  arm();
  return {
    snapshot: () => state,
    files: () => [...outputFiles.values()],
    stop: () => {
      clearTimeout(watchdog);
      emit({
        status: "stopped",
        ...(state.work?.status === "running" ? { work: { ...state.work, status: "cancelled" as const } } : {}),
      });
      return run.stop();
    },
  };
}
export type ArtifactSession = ReturnType<typeof createArtifactSession>;
