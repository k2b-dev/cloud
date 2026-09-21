import { z } from "zod";
import { LIMITS } from "../contracts";
import {
  AnalyticsEvent,
  AnalyticsNode,
  DateRange,
  type ExplorerData,
  ExplorerRequest,
  ExplorerSnapshot,
  type Row,
} from "./analytics-contracts";

type NodeInput = z.input<typeof AnalyticsNode>;
type Options<K extends AnalyticsNode["type"]> = Omit<Extract<NodeInput, { type: K }>, "type" | "id"> & { id?: string };
type Handle = { id: string };
type Callback = (event: AnalyticsEvent) => unknown;
function sameRequest(a: z.infer<typeof ExplorerRequest>, b: z.infer<typeof ExplorerRequest>) {
  return (
    a.step === b.step &&
    a.referenceStep === b.referenceStep &&
    (a.visibleKeys === undefined) === (b.visibleKeys === undefined) &&
    a.visibleKeys?.length === b.visibleKeys?.length &&
    !a.visibleKeys?.some((key) => !b.visibleKeys?.includes(key))
  );
}
export function createAnalyticsUi(
  publish: (nodes: AnalyticsNode[]) => void,
  pickFiles?: (options: { accept?: string; multiple: boolean }) => Promise<File[]>,
) {
  const nodes = new Map<string, AnalyticsNode>();
  const callbacks = new Map<string, Callback>();
  const activeButtons = new Set<string>();
  let sequence = 0;
  const flush = () => publish([...nodes.values()]);
  function commit(input: unknown) {
    const parsed = AnalyticsNode.parse(input);
    nodes.set(parsed.id, parsed);
    return parsed;
  }
  function create<T extends { id?: string }>(type: AnalyticsNode["type"], options: T, callback?: Callback) {
    const id = options.id ?? `node-${sequence++}`;
    if (nodes.has(id)) throw new Error(`Duplicate UI id ${JSON.stringify(id)}. Give every control and chart its own id.`);
    if (nodes.size >= LIMITS.nodes) throw new Error(`UI node limit reached (${LIMITS.nodes}). Aggregate data or simplify the layout.`);
    commit({ ...options, type, id });
    if (callback) callbacks.set(id, callback);
    flush();
    const update = (patch: object) => {
      commit({ ...nodes.get(id), ...patch, type, id });
      flush();
    };
    return {
      id,
      update,
      setLoading: (loading: boolean) => update({ loading }),
      setDisabled: (disabled: boolean) => update({ disabled }),
      setDescription: (description: string) => update({ description }),
    };
  }
  function control<T extends { id?: string; value: unknown }, V>(
    type: "input" | "select" | "multiSelect" | "number" | "slider" | "dateRange",
    options: T,
    parse: (value: unknown) => V,
    onChange?: (value: V) => unknown,
  ) {
    const handle = create(type, options, (event) => {
      if (event.type !== "change") throw new Error("Expected a change event");
      const value = parse(event.value);
      handle.update({ value });
      return onChange?.(value);
    });
    return {
      id: handle.id,
      setOptions: (options: Partial<Omit<T, "id">>) => handle.update(options),
      setValue: (value: V) => handle.update({ value: parse(value) }),
      getValue: (): V => {
        const current = nodes.get(handle.id);
        if (!current || !("value" in current)) throw new Error("Missing control");
        return parse(current.value);
      },
      setLoading: handle.setLoading,
      setDisabled: handle.setDisabled,
    };
  }
  const groups = new Map<string, { select: (key: string | null) => void }>();
  const select = (id: string, key: string | null) => {
    const node = nodes.get(id);
    if (!node || !("selectedKey" in node)) throw new Error("This element has no selection");
    const rows = node.type === "explorer" ? node.data.rows : node.type === "table" ? node.rows : undefined;
    const rowKey = node.type === "explorer" ? node.data.rowKey : node.type === "table" ? node.rowKey : undefined;
    if (key !== null && rows && rowKey && !rows.some((row) => row[rowKey] === key)) throw new Error("Selection is not in the current data");
    if (node.type === "chart" && key !== null && !node.data.marks?.some((mark) => mark.rowKey === key))
      throw new Error("Unknown chart selection");
    if (node.type === "explorer" && node.group) groups.get(node.group)?.select(key);
    else {
      commit({ ...node, selectedKey: key });
      flush();
    }
  };
  function chartExplorer(
    input: Options<"explorer"> & { onSelect?: (row: Row | null) => unknown; onViewChange?: (view: "chart" | "table") => unknown },
  ) {
    const { onSelect, onViewChange, ...options } = input;
    const handle = create("explorer", options, (event) => {
      const node = nodes.get(handle.id);
      if (node?.type !== "explorer") throw new Error("Missing explorer");
      if (event.type === "view") {
        handle.update({ view: event.value });
        return onViewChange?.(event.value);
      }
      if (event.type !== "select") throw new Error("Expected selection or view event");
      select(handle.id, event.key);
      return onSelect?.(node.data.rows.find((row) => row[node.data.rowKey] === event.key) ?? null);
    });
    return {
      id: handle.id,
      setData: (data: ExplorerData) => {
        const current = nodes.get(handle.id);
        if (current?.type !== "explorer") throw new Error("Missing explorer");
        handle.update({
          data,
          selectedKey: data.rows.some((row) => row[data.rowKey] === current.selectedKey) ? current.selectedKey : null,
        });
      },
      setOptions: (options: Pick<Options<"explorer">, "label" | "description" | "columns" | "view">) => handle.update(options),
      select: (key: string | null) => select(handle.id, key),
      setLoading: handle.setLoading,
    };
  }
  function explorer(
    input: Omit<Options<"group">, "desired"> & {
      load: (request: z.infer<typeof ExplorerRequest>, context: { signal: AbortSignal }) => ExplorerSnapshot | Promise<ExplorerSnapshot>;
    },
  ) {
    const { load, ...options } = input;
    const ids = Object.keys(options.snapshot.charts).sort();
    if (!ids.length) throw new Error("An explorer requires named charts");
    let pending: AbortController | undefined;
    const handle = create("group", { ...options, desired: options.snapshot.request }, (event) => {
      if (event.type === "request") return request(event.request);
      if (event.type === "refresh") return request(current().desired, true);
      throw new Error("Expected request or refresh event");
    });
    function current() {
      const node = nodes.get(handle.id);
      if (node?.type !== "group") throw new Error("Missing explorer group");
      return node;
    }
    const members = new Map<string, string>();
    function adopt(snapshot: ExplorerSnapshot) {
      const parsed = ExplorerSnapshot.parse(snapshot);
      if (JSON.stringify(Object.keys(parsed.charts).sort()) !== JSON.stringify(ids))
        throw new Error("A load must return every configured chart");
      const selectedKey = Object.values(parsed.charts).some((data) => data.rows.some((row) => row[data.rowKey] === current().selectedKey))
        ? current().selectedKey
        : null;
      const replacements = [...members].map(([name, id]) =>
        AnalyticsNode.parse({ ...nodes.get(id), data: parsed.charts[name], selectedKey, loading: false }),
      );
      commit({ ...current(), snapshot: parsed, selectedKey, loading: false, error: undefined });
      replacements.forEach((node) => nodes.set(node.id, node));
      flush();
    }
    async function request(input: z.infer<typeof ExplorerRequest>, force = false) {
      const desired = ExplorerRequest.parse(input);
      if (desired.referenceStep && !current().comparison) throw new Error("Comparisons are not enabled for this explorer");
      if (!force && pending && sameRequest(desired, current().desired)) return;
      pending?.abort();
      if (!force && sameRequest(desired, current().snapshot.request)) {
        pending = undefined;
        handle.update({ desired, loading: false, error: undefined });
        return;
      }
      const controller = new AbortController();
      pending = controller;
      handle.update({ desired, loading: true, error: undefined });
      try {
        const next = ExplorerSnapshot.parse(await load(desired, { signal: controller.signal }));
        if (controller.signal.aborted || pending !== controller) return;
        if (!sameRequest(next.request, desired)) throw new Error("Result filters do not match requested filters");
        adopt(next);
      } catch (error) {
        if (!controller.signal.aborted && pending === controller)
          handle.update({ error: error instanceof Error ? error.message : "Could not load data", loading: false });
      } finally {
        if (pending === controller) pending = undefined;
      }
    }
    groups.set(handle.id, {
      select(key) {
        const state = current();
        if (key !== null && !Object.values(state.snapshot.charts).some((data) => data.rows.some((row) => row[data.rowKey] === key)))
          throw new Error("Unknown shared selection");
        commit({ ...state, selectedKey: key });
        for (const id of members.values()) commit({ ...nodes.get(id), selectedKey: key });
        flush();
      },
    });
    return {
      id: handle.id,
      chart(name: string, options: Omit<Options<"explorer">, "data" | "group" | "cursor">) {
        const data = current().snapshot.charts[name];
        if (!data || members.has(name)) throw new Error("Unknown or already mounted chart");
        const chart = chartExplorer({ ...options, data, selectedKey: current().selectedKey, group: handle.id, cursor: handle.id });
        members.set(name, chart.id);
        return { id: chart.id, select: chart.select, setOptions: chart.setOptions };
      },
      setRequest: (value: z.infer<typeof ExplorerRequest>) => request(value),
      refresh: () => request(current().desired, true),
      retry: () => request(current().desired, true),
      pinReference: () => {
        const state = current();
        if (state.snapshot.request.step) return request({ ...state.desired, referenceStep: state.snapshot.request.step });
      },
      clearReference: () => {
        const { referenceStep, ...rest } = current().desired;
        return request(rest);
      },
      select: (key: string | null) => groups.get(handle.id)!.select(key),
      setData: (snapshot: ExplorerSnapshot) => {
        pending?.abort();
        pending = undefined;
        adopt(snapshot);
        handle.update({ desired: snapshot.request });
      },
      cancel: () => {
        pending?.abort();
        pending = undefined;
        handle.update({ loading: false });
      },
    };
  }
  const ui = {
    input: (input: Options<"input"> & { onChange?: (value: string) => unknown }) => {
      const { onChange, ...options } = input;
      return control("input", options, (value) => z.string().parse(value), onChange);
    },
    select: (input: Options<"select"> & { onChange?: (value: string) => unknown }) => {
      const { onChange, ...options } = input;
      return control("select", options, (value) => z.string().parse(value), onChange);
    },
    multiSelect: (input: Options<"multiSelect"> & { onChange?: (value: string[]) => unknown }) => {
      const { onChange, ...options } = input;
      return control("multiSelect", options, (value) => z.array(z.string()).parse(value), onChange);
    },
    number: (input: Options<"number"> & { onChange?: (value: number | null) => unknown }) => {
      const { onChange, ...options } = input;
      return control("number", options, (value) => z.number().nullable().parse(value), onChange);
    },
    slider: (input: Options<"slider"> & { onChange?: (value: number) => unknown }) => {
      const { onChange, ...options } = input;
      return control("slider", options, (value) => z.number().parse(value), onChange);
    },
    dateRange: (input: Options<"dateRange"> & { onChange?: (value: z.infer<typeof DateRange>) => unknown }) => {
      const { onChange, ...options } = input;
      return control("dateRange", options, (value) => DateRange.parse(value), onChange);
    },
    filePicker: (input: Omit<Options<"filePicker">, "names"> & { onChange: (files: File[]) => unknown }) => {
      const { onChange, ...options } = input;
      const handle = create("filePicker", options, async () => {
        if (!pickFiles) throw new Error("A file picker host is required");
        const node = nodes.get(handle.id);
        if (node?.type !== "filePicker") throw new Error("Missing file picker");
        const files = await pickFiles({ accept: node.accept, multiple: node.multiple });
        if (!files.length) return;
        handle.update({
          names: files
            .slice(0, 3)
            .map((file) => file.name)
            .join(", ")
            .slice(0, LIMITS.text),
        });
        await onChange(files);
      });
      return { id: handle.id, setDisabled: handle.setDisabled, setLoading: handle.setLoading };
    },
    button: (input: Options<"button"> & { onClick: () => unknown }) => {
      const { onClick, ...options } = input;
      const h = create("button", options, () => onClick());
      return {
        id: h.id,
        setOptions: (options: Partial<Options<"button">>) => h.update(options),
        setLoading: h.setLoading,
        setDisabled: h.setDisabled,
      };
    },
    text: (options: Options<"text">) => {
      const h = create("text", options);
      return { id: h.id, setValue: (value: string) => h.update({ value }) };
    },
    stat: (options: Options<"stat">) => {
      const h = create("stat", options);
      return {
        id: h.id,
        setValue: (value: number | null) => h.update({ value }),
        setOptions: (options: Partial<Omit<Options<"stat">, "id">>) => h.update(options),
        setLoading: h.setLoading,
      };
    },
    chart: (input: Options<"chart"> & { onSelect?: (key: string | null) => unknown }) => {
      const { onSelect, ...options } = input;
      if (onSelect && !options.data.marks) throw new Error("Chart selection callbacks require explicit mark mappings");
      const h = create("chart", options, (event) => {
        if (event.type !== "select") throw new Error("Expected selection");
        select(h.id, event.key);
        return onSelect?.(event.key);
      });
      return {
        id: h.id,
        setData: (data: Options<"chart">["data"]) => {
          if (onSelect && !data.marks) throw new Error("Chart selection callbacks require explicit mark mappings");
          h.update({ data, selectedKey: null });
        },
        setOptions: (options: Partial<Omit<Options<"chart">, "id" | "data">>) => h.update(options),
        select: (key: string | null) => select(h.id, key),
        setLoading: h.setLoading,
      };
    },
    table: (input: Options<"table"> & { onSelect?: (row: Row | null) => unknown }) => {
      const { onSelect, ...options } = input;
      const h = create("table", options, (event) => {
        if (event.type !== "select") throw new Error("Expected selection");
        select(h.id, event.key);
        const node = nodes.get(h.id);
        if (node?.type === "table") return onSelect?.(node.rows.find((row) => row[node.rowKey] === event.key) ?? null);
      });
      return {
        id: h.id,
        setData: (rows: Row[]) => {
          const node = nodes.get(h.id);
          if (node?.type !== "table") throw new Error("Missing table");
          h.update({ rows, selectedKey: rows.some((row) => row[node.rowKey] === node.selectedKey) ? node.selectedKey : null });
        },
        setColumns: (columns: Options<"table">["columns"]) => h.update({ columns }),
        select: (key: string | null) => select(h.id, key),
      };
    },
    chartExplorer,
    explorer,
    row: (options: { id?: string; children: Handle[] }) => layout("row", options),
    column: (options: { id?: string; children: Handle[] }) => layout("column", options),
    grid: (options: { id?: string; children: Handle[]; minWidth?: number }) => layout("grid", options),
    section: (options: { id?: string; label: string; description?: string; children: Handle[] }) => layout("section", options),
  };
  function layout(
    layout: "row" | "column" | "grid" | "section",
    options: { id?: string; children: Handle[]; label?: string; description?: string; minWidth?: number },
  ) {
    const children = options.children.map((child) => child.id);
    const owned = new Set([...nodes.values()].flatMap((node) => (node.type === "layout" ? node.children : [])));
    if (new Set(children).size !== children.length || children.some((id) => !nodes.has(id) || owned.has(id)))
      throw new Error("A UI element belongs to exactly one layout");
    const handle = create("layout", { ...options, layout, children });
    return { id: handle.id };
  }
  return {
    ui,
    async event(id: string, input: unknown) {
      const node = nodes.get(id);
      if (!node) throw new Error("Control does not exist");
      const event = AnalyticsEvent.parse(input);
      if (event.type === "renderError") throw new Error(event.message);
      if (node.disabled || (node.loading && node.type !== "group")) throw new Error("Control is unavailable");
      if (!callbacks.has(id)) throw new Error("This element has no interaction");
      if (activeButtons.has(id)) throw new Error("Button action is already running");
      if (node.type !== "button" && node.type !== "filePicker") return callbacks.get(id)?.(event);
      if (event.type !== "change" || event.value !== null) throw new Error("Expected a button activation");
      activeButtons.add(id);
      commit({ ...node, loading: true });
      flush();
      try {
        return await callbacks.get(id)?.(event);
      } finally {
        activeButtons.delete(id);
        commit({ ...nodes.get(id), loading: false });
        flush();
      }
    },
    snapshot: () => [...nodes.values()],
  };
}

export type AnalyticsUi = ReturnType<typeof createAnalyticsUi>["ui"];
