import { z } from "zod";
import Papa from "papaparse";
import { common, money } from "@k2b/stdlib";
import { LIMITS } from "../contracts";
import { UiNode } from "./protocol";
import { ModalRequest } from "./modal-schema";
import { ChartOptions } from "./chart-schema";
import { setUiValue, upsertUiItems, removeUiItems } from "./ui-mutations";

type Definition = () => unknown;
type ListItem = { id: string; title: string; description?: string; icon?: string; data?: Record<string, string | number | boolean | null> };
type ListAction = { id: string; label: string; icon?: string; variant?: UiNode["variant"]; onClick: (item: UiNode["items"][number]) => unknown };
const listActions = new Map<string, Map<string, ListAction["onClick"]>>();
type Handle = {
  id: string;
  set: (v: unknown) => void;
  upsert: (v: unknown) => void;
  remove: (ids?: (string | number)[]) => void;
  getValue: () => string;
  setDescription: (v: string) => void;
  setColumns: (v: UiNode["columns"]) => void;
  setDisabled: (v: boolean) => void;
  setLoading: (v: boolean) => void;
  setState: (v: UiNode["state"], description?: string) => void;
};
const send = globalThis.postMessage.bind(globalThis);
const nodes = new Map<string, UiNode>(),
  callbacks = new Map<string, (value: string) => unknown>();
let seq = 0,
  requestId = 0,
  scheduled = false,
  busy = false;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function rpc(method: string, args: unknown[] = []) {
  if (pending.size >= LIMITS.pendingRequests) return Promise.reject(new Error("Too many pending host requests"));
  return new Promise<unknown>((resolve, reject) => {
    const id = requestId++;
    pending.set(id, { resolve, reject });
    try { send({ type: "rpc", id, method, args }); }
    catch (error) { pending.delete(id); reject(error); }
  });
}
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function flushNow() {
  if (!scheduled) return;
  clearTimeout(flushTimer);
  scheduled = false;
  send({ type: "ui", nodes: [...nodes.values()] });
}
function flush() {
  if (scheduled) return;
  scheduled = true;
  flushTimer = setTimeout(flushNow, 16);
}
function node(kind: UiNode["kind"], label = "", extra: Partial<UiNode> = {}, callback?: (value: string) => unknown): Handle {
  if (nodes.size >= LIMITS.nodes) throw new Error("UI node limit reached");
  const id = extra.id ?? `node-${seq++}`;
  if (nodes.has(id)) throw new Error(`Duplicate UI id ${id}`);
  const n = UiNode.parse({ kind, label, ...extra, id });
  if (kind === "list") setUiValue(n, n.items);
  nodes.set(id, n);
  if (callback) callbacks.set(id, callback);
  flush();
  return {
    id,
    upsert: (items) => {
      upsertUiItems(n, items);
      flush();
    },
    remove: (ids) => {
      removeUiItems(n, ids);
      flush();
    },
    setDescription: (v) => {
      n.description = v;
      flush();
    },
    setColumns: (v) => {
      n.columns = UiNode.shape.columns.parse(v);
      flush();
    },
    setDisabled: (v) => {
      n.disabled = v;
      flush();
    },
    setLoading: (v) => {
      n.loading = v;
      flush();
    },
    setState: (v, description) => {
      n.state = v;
      if (description !== undefined || n.kind === "status") n.description = description ?? "";
      flush();
    },
    set: (v) => {
      setUiValue(n, v);
      flush();
    },
    getValue: () => n.value,
  };
}
const textError = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));
for (const level of ["log", "info", "warn", "error"] as const) {
  console[level] = (...args: unknown[]) => {
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
type ControlOptions = {
  id?: string;
  description?: string;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
};
type ButtonOptions = ControlOptions & { variant?: UiNode["variant"] };
type FilePickerOptions = ControlOptions & {
  accept?: string;
  multiple?: boolean;
  onChange: (files: File[]) => unknown;
};
function scopedStorage(scope: "local" | "shared", area: "kv" | "files") {
  const call = (operation: string, key?: string, value?: unknown) => rpc("storage", [{scope,area,operation,key,value}]);
  return area === "kv" ? {
    get: (key: string) => call("read",key), set: (key: string,value: unknown) => call("write",key,value),
    delete: (key: string) => call("delete",key), keys: () => call("list"),
  } : {
    read: (key: string) => call("read",key), write: (key: string,value: Blob | string) => call("write",key,value),
    delete: (key: string) => call("delete",key), list: () => call("list"),
  };
}
const api = {
  money,
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
    chart: (options: unknown) => node("chart", "", { chart: ChartOptions.parse(options) }),
    text: (value: string) => node("text", value),
    button: (label: string, onClick: () => unknown, options: ButtonOptions = {}) => node("button", label, options, onClick),
    input: (
      label: string,
      options: ControlOptions & {
        value?: string;
        placeholder?: string;
        onChange?: (value: string) => unknown;
      } = {},
    ) => {
      const { onChange, ...display } = options;
      return node("input", label, display, onChange);
    },
    select: (label: string, options: UiNode["options"], initial = "", id?: string) =>
      node("select", label, {
        options,
        value: initial,
        id: id ?? `node-${seq++}`,
      }),
    table: (options: { columns: UiNode["columns"]; rowKey?: string; id?: string; label?: string; empty?: UiNode["empty"] }) =>
      node("table", options.label, { state: "empty", ...options }),
    section: (options: { title: string; description?: string }, children: Handle[]) =>
      node("section", options.title, {
        description: options.description,
        children: children.map((c) => c.id),
      }),
    workbench: (options: { controls: Handle[]; content: Handle[]; footer?: { status?: Handle; actions?: Handle[] } }) => {
      if (!Array.isArray(options.controls) || !Array.isArray(options.content) || (options.footer?.actions !== undefined && !Array.isArray(options.footer.actions))) {
        throw new Error("ui.workbench expects controls and content arrays of UI handles; footer.actions must also be an array.");
      }
      const controls = options.controls.map((c) => c.id),
        content = options.content.map((c) => c.id);
      const footer = options.footer
        ? {
            status: options.footer.status?.id,
            actions: (options.footer.actions ?? []).map((c) => c.id),
          }
        : undefined;
      return node("workbench", "", {
        controls,
        content,
        footer,
        children: [...controls, ...content, ...(footer?.status ? [footer.status] : []), ...(footer?.actions ?? [])],
      });
    },
    status: (text: string) => node("status", text),
    markdown: (source: string, options: { headingScale?: UiNode["headingScale"]; id?: string } = {}) =>
      node("markdown", "", { ...options, value: source }),
    link: (label: string, options: { href: string; newTab?: boolean; icon?: string }) =>
      node("link", label, {
        link: { href: options.href, newTab: options.newTab ?? false },
        icon: options.icon,
      }),
    linkButton: (label: string, options: ButtonOptions & { href: string; newTab?: boolean }) => {
      const { href, newTab = false, ...display } = options;
      return node("linkButton", label, { ...display, link: { href, newTab } });
    },
    filePicker: (label: string, options: FilePickerOptions) => {
      const { accept, multiple = false, onChange, ...display } = options;
      const handle = node("filePicker", label, display, async () => {
        const result = await rpc(multiple ? "file.openMultiple" : "file.open", [{ accept }]);
        const files = (Array.isArray(result) ? result : [result]).filter((file): file is File => file instanceof File);
        if (!files.length) return;
        const n = nodes.get(handle.id)!;
        n.value = files.map((file) => file.name).join(", ");
        flush();
        await onChange(files);
      });
      return handle;
    },
    list: (options: {
      title?: string; description?: string; empty?: UiNode["empty"]; id?: string;
      actions?: ListAction[];
    } = {}, items: ListItem[] = []) => {
      const { title = "", actions = [], ...display } = options;
      if (new Set(actions.map((action) => action.id)).size !== actions.length) throw new Error("Duplicate action ids");
      const handle = node("list", title, {
        ...display, items: UiNode.shape.items.parse(items),
        actions: actions.map(({ onClick, ...action }) => action),
      });
      listActions.set(handle.id, new Map(actions.map((action) => [action.id, action.onClick])));
      return handle;
    },
    progress: () => node("progress"),
    row: (options: { gap?: UiNode["gap"] }, children: Handle[]) =>
      node("row", "", {
        gap: options.gap,
        children: children.map((c) => c.id),
      }),
    column: (options: { gap?: UiNode["gap"] }, children: Handle[]) =>
      node("column", "", {
        gap: options.gap,
        children: children.map((c) => c.id),
      }),
  },
  capabilities: {run:(name:string,input:unknown={}) => rpc("capabilities.run",[name,input])},
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
    read: (path: string) => rpc("file.read", [path]),
    open: (options: { accept?: string } = {}) => rpc("file.open", [options]),
    openMultiple: (options: { accept?: string } = {}) => rpc("file.openMultiple", [options]),
    openFolder: () => rpc("file.openFolder"),
    save: (data: Blob | string, name: string) => rpc("file.save", [data, name]),
  },
  sheet: {
    fromCsv: async (file: File | string, options: { delimiter?: string } = {}) => {
      const result = Papa.parse<Record<string, string>>(typeof file === "string" ? file : await file.text(), {
        header: true,
        skipEmptyLines: true,
        delimiter: options.delimiter,
      });
      if (result.errors.length) throw new Error(result.errors[0]?.message ?? "Invalid CSV");
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
for (const [name, value] of Object.entries(api)) Object.defineProperty(globalThis, name, { value, writable: false });
let started = false;
globalThis.addEventListener("message", async (event: MessageEvent) => {
  const m = event.data;
  if (m.type === "result") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(m.error));
    else p?.resolve(m.value);
    return;
  }
  if (m.type === "event") {
    let failure: string | undefined;
    let ownsBusy = false;
    try {
      const n = nodes.get(m.id);
      if (!n || n.disabled || n.loading || busy) throw new Error("Control is unavailable or busy");
      if (m.action !== undefined) {
        const action = listActions.get(n.id)?.get(m.action);
        const item = n.items.find((item) => item.id === m.item);
        if (!action || !item) throw new Error("List action or item no longer exists");
        busy = true; ownsBusy = true;
        send({ type: "busy", value: true });
        await action(item);
      } else {
        if (m.value !== undefined) {
          if (n.kind !== "input" && n.kind !== "select") throw new Error("This control has no editable value");
          setUiValue(n, m.value);
          flush();
        }
        const cb = callbacks.get(m.id);
        if (cb) {
          busy = true; ownsBusy = true;
          const result = cb(n.value);
          if (result instanceof Promise) { send({ type: "busy", value: true }); await result; }
        }
      }
    } catch (error) {
      failure = textError(error).slice(0, LIMITS.text);
      send({ type: "error", text: failure });
    } finally {
      if (ownsBusy) { busy = false; send({ type: "busy", value: false }); }
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
      const result = await definition();
      if (result !== undefined) {
        try { send({ type: "output", value: result }); }
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
