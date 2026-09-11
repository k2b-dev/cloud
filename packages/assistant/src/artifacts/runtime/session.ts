import { LIMITS } from "../contracts";
import { startArtifactRun } from "./host";
import { ModalRequest } from "./modal-schema";
import { validateModalResponse } from "./modal-response";
import type { RuntimeEvent, UiNode } from "./protocol";

export type RunLog = { time: string; level: string; text: string };
export type RunSnapshot = {
  status: "starting" | "ready" | "waiting" | "stopped" | "error";
  busy: boolean;
  nodes: UiNode[];
  logs: RunLog[];
  output?: unknown;
  error?: string;
  modal?: ModalRequest;
  modalId?: string;
  files: { name: string; size: number; type: string }[];
};
export type SessionOptions = {
  mode: "user" | "test";
  changed: (snapshot: RunSnapshot) => void;
  inputs?: File[];
  storage?: (method: string, args: unknown[]) => Promise<unknown>;
  modal?: (request: ModalRequest, signal: AbortSignal) => Promise<unknown>;
  pick?: (multiple: boolean, folder: boolean, accept: string, signal: AbortSignal) => Promise<File[]>;
  save?: (file: File, signal: AbortSignal) => Promise<void>;
};

/** One run owns its effects and state. Test runs never reach a user's local storage or file picker. */
export function createArtifactSession(container: HTMLElement, source: { runtime: string; code: string }, options: SessionOptions) {
  let state: RunSnapshot = { status: "starting", busy: false, nodes: [], logs: [], files: [] };
  const inputs = options.inputs ?? [];
  if (inputs.length > LIMITS.files || inputs.reduce((size, file) => size + file.size, 0) > LIMITS.rpcBytes)
    throw new Error("Input files exceed the run budget");
  if (new Set(inputs.map((file) => file.name)).size !== inputs.length) throw new Error("Input file names must be unique");
  const outputFiles = new Map<string, File>();
  const memory = new Map<string, unknown>();
  const memoryBytes = new Map<string, number>();
  let modalSequence = 0;
  let modal: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let errorGeneration = 0;
  const emit = (patch: Partial<RunSnapshot>) => {
    state = { ...state, ...patch };
    options.changed(state);
  };
  const log = (level: string, text: string) => emit({ logs: [...state.logs, { time: new Date().toISOString(), level, text }].slice(-LIMITS.logs) });
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      emit({ status: "error", error: "Run timed out before becoming ready", busy: false });
      void run.stop();
    }, 15000);
  };
  const run = startArtifactRun(container, source, {
    ui: (nodes) => emit({ nodes }),
    busy: (busy) => emit({ busy }),
    log,
    output: (output) => emit({ output }),
    error: (error) => {
      errorGeneration++;
      const initial = state.status === "starting";
      clearTimeout(watchdog); emit({ status: "error", error }); log("error", error);
      if (initial) void run.stop();
    },
    ready: () => { clearTimeout(watchdog); emit({ status: "ready" }); },
    request: async (method, args, signal) => {
      if (method === "ui.modal") {
        const request = ModalRequest.parse(args[0]);
        const previous = state.status;
        clearTimeout(watchdog);
        emit({ status: "waiting", modal: request, modalId: `@modal:${++modalSequence}` });
        try {
          const value = options.mode === "user"
            ? await options.modal?.(request, signal)
            : await new Promise<unknown>((resolve, reject) => {
                const abort = () => reject(new Error("Run stopped"));
                signal.addEventListener("abort", abort, { once: true });
                modal = {
                  resolve: (value) => { signal.removeEventListener("abort", abort); resolve(value); },
                  reject: (error) => { signal.removeEventListener("abort", abort); reject(error); },
                };
                if (signal.aborted) abort();
              });
          return validateModalResponse(request, value);
        } finally {
          modal = undefined;
          if (!signal.aborted) {
            emit({ status: previous, modal: undefined, modalId: undefined });
            if (previous === "starting") arm();
          }
        }
      }
      if (method === "file.list") return inputs.map((file) => ({ name: file.name, size: file.size, type: file.type }));
      if (method === "file.read") {
        const file = inputs.find((file) => file.name === args[0]);
        if (!file) throw new Error("Input file not found; use files.list() first");
        return file;
      }
      if (method === "file.open" || method === "file.openMultiple" || method === "file.openFolder") {
        if (options.mode === "test") return method === "file.open" ? inputs[0] ?? null : inputs;
        const accept = typeof args[0] === "object" && args[0] !== null && "accept" in args[0] && typeof args[0].accept === "string" ? args[0].accept : "";
        const files = await options.pick?.(method !== "file.open", method === "file.openFolder", accept, signal) ?? [];
        if (files.length > LIMITS.files || files.reduce((size, file) => size + file.size, 0) > LIMITS.rpcBytes)
          throw new Error("Selected files exceed the run budget");
        return method === "file.open" ? files[0] ?? null : files;
      }
      if (method === "file.save") {
        const [data, name] = args;
        if ((typeof data !== "string" && !(data instanceof Blob)) || typeof name !== "string" || !name || name.length > 180 || /[\/\\\x00]/.test(name))
          throw new Error("Invalid output file");
        const file = new File([data], name, { type: data instanceof Blob ? data.type : "text/plain" });
        const total = [...outputFiles.values()].reduce((size, item) => size + (item.name === name ? 0 : item.size), file.size);
        if (total > LIMITS.rpcBytes || (!outputFiles.has(name) && outputFiles.size >= LIMITS.files)) throw new Error("Output files exceed the run budget");
        if (options.mode === "user") await options.save?.(file, signal);
        outputFiles.set(name, file);
        emit({ files: [...outputFiles.values()].map((file) => ({ name: file.name, size: file.size, type: file.type })) });
        return null;
      }
      if (method.startsWith("store.") || method.startsWith("opfs.")) {
        if (options.mode === "user") {
          if (!options.storage) throw new Error("Storage unavailable");
          return options.storage(method, args);
        }
        const [area, operation] = method.split(".");
        if (operation === "keys" || operation === "list") return [...memory.keys()].filter((key) => key.startsWith(`${area}:`)).map((key) => key.slice(area!.length + 1)).sort();
        if (typeof args[0] !== "string" || !args[0] || args[0].length > 240) throw new Error("Invalid storage key");
        const key = `${area}:${args[0]}`;
        if (operation === "delete") { memory.delete(key); memoryBytes.delete(key); return null; }
        if (operation === "set" || operation === "write") {
          const value = area === "store" ? JSON.stringify(args[1]) : args[1];
          if (typeof value !== "string" && !(value instanceof Blob)) throw new Error("Expected serializable data");
          const size = typeof value === "string" ? new Blob([value]).size : value.size;
          const total = [...memoryBytes.entries()].reduce((sum, [id, bytes]) => sum + (id === key ? 0 : bytes), size);
          if (total > LIMITS.rpcBytes || (!memory.has(key) && memory.size >= 1000)) throw new Error("Storage budget exceeded");
          memoryBytes.set(key, size);
          memory.set(key, area === "store" ? JSON.parse(String(value)) : new Blob([value]));
          return null;
        }
        return memory.get(key) ?? null;
      }
      throw new Error("Unsupported host operation");
    },
  });
  log("info", "Started");
  arm();
  return {
    snapshot: () => state,
    files: () => [...outputFiles.values()],
    event: async (event: RuntimeEvent) => {
      const previousError = errorGeneration;
      await run.event(event);
      // Recover an earlier action failure, retaining its log. An unrelated
      // error raised during this action still belongs to the current state.
      if (state.status === "error" && previousError === errorGeneration)
        emit({ status: "ready", error: undefined });
    },
    respond: (value: unknown) => {
      if (!state.modal || !modal) throw new Error("No pending dialog");
      const validated = validateModalResponse(state.modal, value);
      modal.resolve(validated);
    },
    stop: () => {
      clearTimeout(watchdog);
      modal?.reject(new Error("Run stopped"));
      emit({ status: "stopped", busy: false, modal: undefined, modalId: undefined });
      return run.stop();
    },
  };
}
export type ArtifactSession = ReturnType<typeof createArtifactSession>;
