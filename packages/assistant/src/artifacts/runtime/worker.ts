import { createAi } from "./ai";
import { createPdf } from "./pdf";
import { createAnalyticsUi } from "./analytics-ui";
import { createHttp, secret } from "./http";
import { createWork } from "./work";
import { excel, ods } from "./documents";
import { z } from "zod";
import Papa from "papaparse";
import { datev, sepa, camt, einvoice } from "@k2b/stdlib/finance";
import { common, money } from "@k2b/stdlib";
import { LIMITS } from "../contracts";
import { UiNode } from "./protocol";
import { ModalRequest } from "./modal-schema";

type Definition = () => unknown;
const send = globalThis.postMessage.bind(globalThis);
function sendOutput(value: unknown) {
  if (!z.json().safeParse(value).success) {
    throw new Error("Output must be JSON data. Replace undefined values with null. Do not return UI handles, functions, or class instances. Inspect input columns before calculating derived fields.");
  }
  send({type:"output",value});
}
let nodes: UiNode[] = [];
let requestId = 0, scheduled = false;
const filePaths = new WeakMap<File, string>();
function picked(value: unknown): File | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !("file" in value) || !(value.file instanceof File)
    || !("path" in value) || typeof value.path !== "string") throw new Error("Invalid picker result");
  filePaths.set(value.file, value.path);
  return value.file;
}
async function pickMany(method: string, options?: unknown) {
  const value = await rpc(method, options === undefined ? [] : [options]);
  if (!Array.isArray(value)) throw new Error("Invalid picker result");
  return value.map(item => picked(item)).filter((file): file is File => file !== null);
}
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc(method: string, args: unknown[] = [], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (pending.size >= LIMITS.pendingRequests) return Promise.reject(new Error("Too many pending host requests"));
  return new Promise<unknown>((resolve, reject) => {
    const id = requestId++;
    const cancel = () => {
      pending.delete(id);
      send({ type: "cancel", id });
      reject(new DOMException("PDF request cancelled", "AbortError"));
    };
    const clean = () => signal?.removeEventListener("abort", cancel);
    pending.set(id, { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } });
    signal?.addEventListener("abort", cancel, { once: true });
    try { send({ type: "rpc", id, method, args }); }
    catch (error) { const entry = pending.get(id); pending.delete(id); entry?.reject(error instanceof Error ? error : new Error(String(error))); }
  });
}
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
const textError = (e: unknown) => e instanceof z.ZodError ? z.prettifyError(e) : (e instanceof Error ? (e.stack ?? e.message) : String(e));
let logWindow = Date.now(), logCount = 0, suppressedLogs = 0;
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
    if (Date.now() - logWindow >= 1000) {
      logWindow = Date.now(); logCount = 0;
      if (suppressedLogs) { send({type:"log",level:"warn",text:`Suppressed ${suppressedLogs} repetitive log messages`}); suppressedLogs = 0; }
    }
    // Leave transport capacity for UI/RPC. Errors remain visible; the host still
    // terminates a malicious stream that exceeds its overall message budget.
    if (level !== "error" && logCount++ >= LIMITS.logs) { suppressedLogs++; return; }
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
function scopedStorage(scope: "local" | "shared", area: "kv" | "files") {
  const call = (operation: string, key?: string, value?: unknown) => rpc("storage", [{scope,area,operation,key,value}]);
  const list = (options: {after?:string;limit?:number} = {}) => rpc("storage",[{scope,area,operation:"list",...options}]);
  return area === "kv" ? {
    get: (key: string) => call("read",key), set: (key: string,value: unknown) => call("write",key,value),
    delete: (key: string) => call("delete",key), keys: list,
  } : {
    read: (key: string) => call("read",key), write: (key: string,value: Blob | string) => call("write",key,value),
    delete: (key: string) => call("delete",key), list,
  };
}
const analytics = createAnalyticsUi(values => {
  nodes = values;
  flush();
}, async ({ accept, multiple }) => {
  const result = await rpc(multiple ? "file.openMultiple" : "file.open", [{ accept }]);
  return (Array.isArray(result) ? result : [result]).map(picked).filter((file): file is File => file !== null);
});
const api = {
  ai: createAi(rpc),
  money,
  datev,
  sepa,
  camt,
  einvoice,
  ids: { ulid: common.ulid },
  ui: {
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
  },
  http: createHttp(rpc),
  secret,
  capabilities: {
    run:(name:string,input:unknown={}) => rpc("capabilities.run",[name,input]),
    streams: {
      read:(ref:unknown) => rpc("capabilities.stream",[ref,"read"]),
      write:(ref:unknown,body:Blob|string|ArrayBuffer|Uint8Array) => rpc("capabilities.stream",[ref,"write",new Blob([body instanceof Uint8Array ? new Uint8Array(body) : body])]),
      status:(ref:unknown) => rpc("capabilities.stream",[ref,"status"]),
      abort:(ref:unknown) => rpc("capabilities.stream",[ref,"abort"]),
    },
  },
  database: {connect: async () => {
    await rpc("database",[{operation:"connect"}]);
    const call = (request: unknown) => rpc("database",[request]);
    return {
      query:(sql: string,params: unknown[] = []) => call({operation:"query",sql,params}),
      tables:() => call({operation:"tables.list"}),
      createTable:(name: string,columns: unknown[]) => call({operation:"tables.create",name,columns}),
      table:(table: string) => ({
        schema:() => call({operation:"schema.get",table}),
        alter:(changes: unknown) => call({operation:"tables.update",table,changes}),
        list:(query: Record<string,unknown> = {}) => call({operation:"rows.list",table,query}),
        get:(id: number) => call({operation:"rows.get",table,id}),
        insert:(rows: unknown) => call({operation:"rows.insert",table,rows}),
        update:(id: number,row: unknown) => call({operation:"rows.update",table,id,row}),
        delete:(id: number) => call({operation:"rows.delete",table,id}),
      }),
    };
  }},
  kv: {local:scopedStorage("local","kv"),shared:scopedStorage("shared","kv")},
  files: {
    local:scopedStorage("local","files"), shared:scopedStorage("shared","files"),
    list: () => rpc("file.list"),
    read: async (path: string) => picked(await rpc("file.read", [path])),
    open: async (options: { accept?: string } = {}) => picked(await rpc("file.open", [options])),
    openMultiple: (options: { accept?: string } = {}) => pickMany("file.openMultiple", options),
    openFolder: () => pickMany("file.openFolder"),
    path: (file: File) => filePaths.get(file) ?? file.name,
    save: (data: Blob | string, name: string) => rpc("file.save", [data, name]),
  },
  work: createWork(state => send({type:"work",...state}), sendOutput, error => send({type:"error",text:textError(error).slice(0,LIMITS.text)})),
  pdf: createPdf(rpc),
  sheet: {
    openExcel: excel.open,
    openOds: ods.open,
    fromCsv: async (file: File | string, options: { delimiter?: string; encoding?: string } = {}) => {
      let content: string;
      try { content = typeof file === "string" ? file : new TextDecoder(options.encoding ?? "utf-8",{fatal:true}).decode(await file.arrayBuffer()); }
      catch { throw new Error("CSV decoding failed. Specify encoding, for example windows-1252 for older Excel exports."); }
      const result = Papa.parse<Record<string, string>>(content, {
        header: true,
        skipEmptyLines: true,
        delimiter: options.delimiter,
      });
      const error=result.errors.find(error=>error.code!=="UndetectableDelimiter");
      if (error) throw new Error(error.message);
      return result.data;
    },
    toCsv: (rows: Record<string, unknown>[], options: { delimiter?: string; bom?: boolean } = {}) =>
      (options.bom === false ? "" : "\uFEFF") +
      Papa.unparse(rows, {
        delimiter: options.delimiter ?? ";",
        newline: "\r\n",
        escapeFormulae: true,
      }),
  },
  store: {
    get: (key: string) => rpc("store.get", [key]),
    set: (key: string, value: unknown) => rpc("store.set", [key, value]),
    delete: (key: string) => rpc("store.delete", [key]),
    keys: () => rpc("store.keys"),
  },
  opfs: {
    read: (path: string) => rpc("opfs.read", [path]),
    write: (path: string, data: Blob | string) => rpc("opfs.write", [path, data]),
    delete: (path: string) => rpc("opfs.delete", [path]),
    list: () => rpc("opfs.list"),
  },
};
for (const [name, value] of Object.entries(api)) Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
let started = false;
globalThis.addEventListener("message", async (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(Object.assign(new Error(m.error), {code: typeof m.code === "string" ? m.code.slice(0,128) : undefined}));
    else p?.resolve(m.value);
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
  value: async (definition: Definition) => {
    if (started) return;
    started = true;
    try {
      if (typeof definition !== "function") throw new Error("The entry module must default-export a function: export default () => { /* create UI or return data */ }. An exported object is not executable.");
      const result = await definition();
      if (result !== undefined) {
        try { sendOutput(result); }
        catch (error) {
          if (error instanceof Error && error.name === "DataCloneError") throw new Error("Entry output must be serializable data. Do not return UI handles or functions; create the UI without returning it.");
          throw error;
        }
      }
      flushNow();
      send({ type: "ready" });
    } catch (e) {
      send({ type: "error", text: textError(e).slice(0, LIMITS.text) });
    }
  },
});
