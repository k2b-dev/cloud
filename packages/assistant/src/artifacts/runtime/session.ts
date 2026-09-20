import { RuntimeStream, runStream } from "./streams";
import { StoragePage } from "./storage";
import type { WorkState } from "./work";
import { RuntimeStorage, localStorageCall } from "./shared-storage";
import { LIMITS } from "../contracts";
import { startArtifactRun } from "./host";
import { ModalRequest } from "./modal-schema";
import { validateModalResponse } from "./modal-response";
import type { RuntimeEvent, UiNode } from "./protocol";

export type RunLog = { time: string; level: string; text: string };
export type RunSnapshot = {
  status: "starting" | "ready" | "waiting" | "stopped" | "error";
  busy: boolean;
  work?: WorkState;
  approvalPending?: boolean;
  inputPending?: boolean;
  pendingRequests?: number;
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
  inputFiles?: {name:string;size:number;type:string}[];
  readInput?: (name:string,signal:AbortSignal)=>Promise<File>;
  pickerInputs?: File[] | ((signal:AbortSignal)=>Promise<File[]>);
  capability?: (name:string,input:unknown,signal:AbortSignal) => Promise<unknown>;
  pdf?: (request: unknown, signal: AbortSignal) => Promise<Blob>;
  http?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  database?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
  storage?: (method: string, args: unknown[]) => Promise<unknown>;
  modal?: (request: ModalRequest, signal: AbortSignal) => Promise<unknown>;
  pick?: (multiple: boolean, folder: boolean, accept: string, signal: AbortSignal) => Promise<File[]>;
  save?: (file: File, signal: AbortSignal) => Promise<void>;
};

/** One run owns its effects and state. Test runs never reach a user's local storage or file picker. */
export function createArtifactSession(container: HTMLElement, source: { runtime: string; code: string }, options: SessionOptions) {
  let state: RunSnapshot = { status: "starting", busy: false, nodes: [], logs: [], files: [] };
  const inputs = options.inputs ?? [];
  const inputFiles = options.inputFiles ?? inputs.map(file=>({name:file.webkitRelativePath || file.name,size:file.size,type:file.type}));
  if (inputFiles.length > LIMITS.files || inputFiles.some(file=>file.size>LIMITS.inputFileBytes) || inputFiles.reduce((size,file)=>size+file.size,0)>LIMITS.inputBytes)
    throw new Error("Selected inputs exceed the chat-file budget (50 MiB per file, 250 MiB total, 64 selected paths)");
  if (new Set(inputFiles.map(file=>file.name)).size!==inputFiles.length) throw new Error("Input paths must be unique");
  const wrap = (file: File) => ({ file, path: file.webkitRelativePath || file.name });
  const outputFiles = new Map<string, File>();
  const memory = new Map<string, unknown>();
  const memoryBytes = new Map<string, number>();
  let modalSequence = 0;
  let capabilityRequests = 0;
  const capabilityStreams = new Map<string, RuntimeStream>();
  let streamBytes = 0;
  let streamRequests = 0;
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
    if (state.work?.status === "running" || streamRequests > 0 || capabilityRequests > 0) return;
    watchdog = setTimeout(() => {
      emit({ status: "error", error: "Run timed out before becoming ready", busy: false });
      void run.stop();
    }, 15000);
  };
  const run = startArtifactRun(container, source, {
    ui: (nodes) => emit({ nodes }),
    pending: pendingRequests => emit({pendingRequests}),
    work: work => { clearTimeout(watchdog); emit({work}); if (work.status !== "running" && state.status === "starting" && !state.inputPending) arm(); },
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
      if (method === "file.list") return inputFiles;
      if (method === "file.read") {
        if (typeof args[0] !== "string" || !inputFiles.some(file=>file.name===args[0])) throw new Error("Input file not found; use files.list() first");
        clearTimeout(watchdog); emit({inputPending:true});
        try {
          const file = options.readInput ? await options.readInput(args[0],signal) : inputs.find(file=>(file.webkitRelativePath || file.name)===args[0]);
          if (!file) throw new Error("Input file not found");
          return wrap(file);
        } finally {
          emit({inputPending:false});
          if (state.status === "starting" && !signal.aborted) arm();
        }
      }
      if (method === "file.open" || method === "file.openMultiple" || method === "file.openFolder") {
        if (options.mode === "test") {
          clearTimeout(watchdog); emit({inputPending:true});
          try {
            const selected = typeof options.pickerInputs === "function" ? await options.pickerInputs(signal) : options.pickerInputs ?? inputs;
            return method === "file.open" ? selected[0] ? wrap(selected[0]) : null : selected.map(wrap);
          } finally {
            emit({inputPending:false});
            if (state.status === "starting" && !signal.aborted) arm();
          }
        }
        const accept = typeof args[0] === "object" && args[0] !== null && "accept" in args[0] && typeof args[0].accept === "string" ? args[0].accept : "";
        const previous = state.status;
        clearTimeout(watchdog); emit({status:"waiting"});
        try {
          const files = await options.pick?.(method !== "file.open", method === "file.openFolder", accept, signal) ?? [];
          // File references cross the bridge; local selection does not upload bytes.
          return method === "file.open" ? files[0] ? wrap(files[0]) : null : files.map(wrap);
        } finally {
          if (!signal.aborted) { emit({status:previous}); if (previous === "starting") arm(); }
        }
      }
      if (method === "file.save") {
        const [data, name] = args;
        if ((typeof data !== "string" && !(data instanceof Blob)) || typeof name !== "string" || !name || name.length > 180 || /[\/\\\x00]/.test(name))
          throw new Error("Invalid output file");
        const file = new File([data], name, { type: data instanceof Blob ? data.type : "text/plain" });
        if (options.mode === "user") {
          await options.save?.(file, signal);
          return null;
        }
        const total = [...outputFiles.values()].reduce((size, item) => size + (item.name === name ? 0 : item.size), file.size);
        if (file.size > LIMITS.inputFileBytes || total > LIMITS.inputBytes || (!outputFiles.has(name) && outputFiles.size >= LIMITS.files)) throw new Error("Output files exceed the run budget");
        outputFiles.set(name, file);
        emit({ files: [...outputFiles.values()].map((file) => ({ name: file.name, size: file.size, type: file.type })) });
        return null;
      }
      if (method === "capabilities.run") {
        if(!options.capability || typeof args[0]!=="string")throw new Error("Capability execution unavailable");
        clearTimeout(watchdog);capabilityRequests++;emit({approvalPending:true});
        try {
          const result=await options.capability(args[0],args[1],signal);
          if(result && typeof result === "object" && "stream" in result && result.stream) {
            const ref=RuntimeStream.parse(result.stream);
            if(capabilityStreams.size >= LIMITS.files)throw new Error("Too many streams in this run");
            capabilityStreams.set(ref.id,ref);
          }
          return result;
        }
        finally {capabilityRequests--;emit({approvalPending:capabilityRequests>0});if(!capabilityRequests&&state.status==="starting"&&!signal.aborted)arm();}
      }
      if (method === "capabilities.stream") {
        const ref=RuntimeStream.parse(args[0]);
        const known=capabilityStreams.get(ref.id);
        if(!known || JSON.stringify(known)!==JSON.stringify(ref))throw new Error("Stream was not issued to this run");
        const verb=args[1];
        if(verb!=="read" && verb!=="write" && verb!=="status" && verb!=="abort")throw new Error("Unknown stream operation");
        if((verb==="read") !== (ref.direction==="read"))throw new Error("Wrong stream direction");
        if(verb==="read" || verb==="write") {
          if(streamBytes+ref.size>LIMITS.inputBytes)throw new Error("Stream transfers exceed the 250 MiB run budget");
          streamBytes+=ref.size;
        }
        clearTimeout(watchdog); streamRequests++; emit({inputPending:true});
        try {return await runStream(ref,verb,args[2] instanceof Blob ? args[2] : undefined,signal);}
        finally {streamRequests--;emit({inputPending:streamRequests>0});if(state.status==="starting"&&!signal.aborted)arm();}
      }
      if (method === "http.fetch") {
        if (!options.http) throw new Error("Server HTTP unavailable");
        clearTimeout(watchdog); capabilityRequests++; emit({approvalPending:true});
        try { return await options.http(args[0],signal); }
        finally { capabilityRequests--; emit({approvalPending:capabilityRequests>0}); if (!capabilityRequests && state.status === "starting" && !signal.aborted) arm(); }
      }
      if (method === "pdf") {
        if (!options.pdf) throw new Error("PDF service unavailable");
        clearTimeout(watchdog); emit({inputPending:true});
        try { return await options.pdf(args[0],signal); }
        finally { emit({inputPending:false}); if (state.status === "starting" && !signal.aborted) arm(); }
      }
      if (method === "database") {
        if (!options.database) throw new Error("Database access requires a saved app or script");
        clearTimeout(watchdog); emit({inputPending:true});
        try {
          const result=await options.database(args[0],signal);
          if (typeof args[0] === "object" && args[0] !== null && "operation" in args[0] && args[0].operation === "connect") log("info","Database connected");
          return result;
        } finally { emit({inputPending:false}); if (!capabilityRequests && state.status === "starting" && !signal.aborted) arm(); }
      }
      if (method === "storage") {
        const request = RuntimeStorage.parse(args[0]);
        if (request.scope === "shared" || options.mode === "user") {
          if (!options.storage) throw new Error("Shared storage requires a saved app or script");
          clearTimeout(watchdog); emit({inputPending:true});
          try { return await options.storage(method,args); }
          finally { emit({inputPending:false}); if(state.status==="starting" && !signal.aborted)arm(); }
        }
        const local = localStorageCall(request);
        method = local.method; args = local.args;
      }
      if (method.startsWith("store.") || method.startsWith("opfs.")) {
        if (options.mode === "user") {
          if (!options.storage) throw new Error("Storage unavailable");
          return options.storage(method, args);
        }
        const [area, operation] = method.split(".");
        if (operation === "keys" || operation === "list") {
          const page = StoragePage.parse(args[0] ?? {});
          return [...memory.keys()].filter((key) => key.startsWith(`${area}:`)).map((key) => key.slice(area!.length + 1)).filter(key=>key>page.after).sort().slice(0,page.limit);
        }
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
