import Papa from "papaparse";
import { money } from "@k2b/stdlib";
import { LIMITS } from "../contracts";
import { UiNode } from "./protocol";

type Definition = {
  name: string;
  icon?: string;
  order?: number;
  run: () => unknown;
};
type Handle = {
  id: string;
  setText: (v: string) => void;
  setRows: (v: Record<string, string | number | boolean | null>[]) => void;
  set: (v: number) => void;
  getValue: () => string;
  setDescription: (v: string) => void;
  setColumns: (v: UiNode["columns"]) => void;
  setMarkdown: (v: string) => void;
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
  return new Promise<unknown>((resolve, reject) => {
    const id = requestId++;
    pending.set(id, { resolve, reject });
    send({ type: "rpc", id, method, args });
  });
}
function flush() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    send({ type: "ui", nodes: [...nodes.values()] });
  });
}
function node(kind: UiNode["kind"], label = "", extra: Partial<UiNode> = {}, callback?: (value: string) => unknown): Handle {
  if (nodes.size >= LIMITS.nodes) throw new Error("UI node limit reached");
  const id = extra.id ?? `node-${seq++}`;
  if (nodes.has(id)) throw new Error(`Duplicate UI id ${id}`);
  const n = UiNode.parse({ kind, label, ...extra, id });
  nodes.set(id, n);
  if (callback) callbacks.set(id, callback);
  flush();
  return {
    id,
    setText: (v) => {
      n.label = v;
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
    setMarkdown: (v) => {
      n.value = v;
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
      if (description !== undefined) n.description = description;
      flush();
    },
    setRows: (v) => {
      if (v.length > LIMITS.rows) throw new Error(`Show at most ${LIMITS.rows} rows at once`);
      n.rows = v;
      n.state = v.length ? "ready" : "empty";
      flush();
    },
    set: (v) => {
      n.progress = v;
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
const kit = {
  money,
  script: (definition: Definition) => definition,
  ui: {
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
    table: (options: { columns: UiNode["columns"]; id?: string; label?: string; empty?: UiNode["empty"] }) =>
      node("table", options.label, { state: "empty", ...options }),
    section: (options: { title: string; description?: string }, children: Handle[]) =>
      node("section", options.title, {
        description: options.description,
        children: children.map((c) => c.id),
      }),
    workbench: (options: { controls: Handle[]; content: Handle[]; footer?: { status?: Handle; actions?: Handle[] } }) => {
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
    list: (
      options: {
        title: string;
        description?: string;
        empty?: UiNode["empty"];
        id?: string;
      },
      items: {
        id: string;
        title: string;
        description?: string;
        icon?: string;
        action?: Handle;
      }[],
    ) => {
      const { title, ...display } = options;
      return node("list", title, {
        ...display,
        items: items.map((item) => ({
          ...item,
          description: item.description ?? "",
          icon: item.icon ?? "",
          action: item.action?.id,
        })),
        children: items.flatMap((item) => (item.action ? [item.action.id] : [])),
      });
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
  file: {
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
Object.defineProperty(globalThis, "kit", { value: kit, writable: false });
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
    const n = nodes.get(m.id);
    if (!n || n.disabled || n.loading) return;
    if (typeof m.value === "string") {
      n.value = m.value;
      flush();
    }
    const cb = callbacks.get(m.id);
    if (cb && !busy) {
      busy = true;
      // Synchronous input updates keep keyboard focus; actions announce busy before execution.
      let waiting = n.kind !== "input";
      if (waiting) send({ type: "busy", value: true });
      try {
        const result = cb(n.value);
        if (result instanceof Promise) {
          if (!waiting) send({ type: "busy", value: true });
          waiting = true;
          await result;
        }
      } catch (e) {
        send({ type: "error", text: textError(e).slice(0, LIMITS.text) });
      } finally {
        busy = false;
        if (waiting) send({ type: "busy", value: false });
      }
    }
    return;
  }
});
globalThis.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) =>
  send({ type: "error", text: textError(e.reason).slice(0, LIMITS.text) }),
);

Object.defineProperty(globalThis, "__kitStart", {
  value: async (definition: Definition) => {
    if (started) return;
    started = true;
    try {
      await definition.run();
      send({ type: "ready" });
    } catch (e) {
      send({ type: "error", text: textError(e).slice(0, LIMITS.text) });
    }
  },
});
