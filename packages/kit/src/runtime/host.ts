import { LIMITS } from "../contracts";
import { FileOpenOptions, WorkerMessage, type UiNode } from "./protocol";
import { sandboxDocument } from "./sandbox";
import { AppStorage } from "./storage";
export type RunHooks = {
  ui: (nodes: UiNode[]) => void;
  log: (level: string, text: string) => void;
  error: (message: string) => void;
  busy: (value: boolean) => void;
  ready: () => void;
  pick: (multiple: boolean, folder: boolean, accept?: string) => Promise<File[]>;
  save: (data: Blob | string, name: string) => Promise<void>;
};
export function startRun(container: HTMLElement, source: { runtime: string; code: string }, storage: AppStorage, hooks: RunHooks) {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.hidden = true;
  frame.title = "Isolated app runtime";
  frame.srcdoc = sandboxDocument();
  let stopped = false,
    windowStart = Date.now(),
    messages = 0,
    logs = 0,
    queued = 0;
  let chain = Promise.resolve();
  const post = (m: unknown) => {
    if (!stopped) frame.contentWindow?.postMessage(m, "*");
  };
  const stop = () => {
    if (stopped) return chain;
    post({ type: "stop" });
    stopped = true;
    window.removeEventListener("message", receive);
    frame.remove();
    hooks.busy(false);
    return chain;
  };
  function checkTree(nodes: UiNode[]) {
    const by = new Map(nodes.map((n) => [n.id, n]));
    if (by.size !== nodes.length) throw new Error("Duplicate UI ids");
    const parent = new Set<string>();
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id)) throw new Error("Cyclic UI tree");
      const n = by.get(id);
      if (!n) throw new Error("Unknown UI child");
      const next = new Set(stack).add(id);
      for (const child of n.children) visit(child, next);
    };
    for (const n of nodes) {
      if (n.children.length && !["row", "column", "section", "workbench", "list"].includes(n.kind)) throw new Error("Invalid children");
      const references =
        n.kind === "workbench"
          ? [...n.controls, ...n.content, ...(n.footer?.status ? [n.footer.status] : []), ...(n.footer?.actions ?? [])]
          : n.kind === "list"
            ? n.items.flatMap((item) => (item.action ? [item.action] : []))
            : n.children;
      if (JSON.stringify(references) !== JSON.stringify(n.children)) throw new Error("Invalid layout references");
      if (new Set(n.items.map((item) => item.id)).size !== n.items.length) throw new Error("Duplicate list item ids");
      for (const c of n.children) {
        if (parent.has(c)) throw new Error("UI child has two parents");
        parent.add(c);
      }
      visit(n.id, new Set());
    }
    const workbenches = nodes.filter((n) => n.kind === "workbench");
    if (workbenches.length > 1 || workbenches.some((n) => parent.has(n.id))) throw new Error("Workbench must be a single root layout");
  }
  async function request(method: string, args: unknown[]) {
    if (stopped) throw new Error("Run stopped");
    if (method.startsWith("store.") || method.startsWith("opfs.")) return storage.call(method, args);
    if (method === "file.open" || method === "file.openMultiple" || method === "file.openFolder") {
      const options = FileOpenOptions.parse(args[0] ?? {});
      const files = await hooks.pick(method !== "file.open", method === "file.openFolder", options.accept);
      return method === "file.open" ? (files[0] ?? null) : files;
    }
    if (method === "file.save") {
      const [data, name] = args;
      if (
        (typeof data !== "string" && !(data instanceof Blob)) ||
        typeof name !== "string" ||
        !name ||
        /[\/\\\x00]/.test(name) ||
        name.length > 180
      )
        throw new Error("Invalid download");
      if ((typeof data === "string" ? new Blob([data]).size : data.size) > LIMITS.rpcBytes) throw new Error("Download exceeds 16 MiB");
      await hooks.save(data, name);
      return null;
    }
    throw new Error("Unsupported host operation");
  }
  function receive(event: MessageEvent) {
    if (stopped || event.source !== frame.contentWindow) return;
    if (Date.now() - windowStart > 1000) {
      windowStart = Date.now();
      messages = 0;
    }
    if (++messages > 600) {
      hooks.error("Run exceeded message budget");
      stop();
      return;
    }
    if (event.data?.type === "bridge-ready") {
      post({ type: "boot", ...source });
      return;
    }
    const parsed = WorkerMessage.safeParse(event.data);
    if (!parsed.success) {
      hooks.error("Invalid runtime message");
      stop();
      return;
    }
    const m = parsed.data;
    try {
      if (m.type === "ui") {
        checkTree(m.nodes);
        hooks.ui(m.nodes);
      } else if (m.type === "log") {
        if (logs++ < LIMITS.logs) hooks.log(m.level, m.text);
      } else if (m.type === "error") hooks.error(m.text);
      else if (m.type === "busy") hooks.busy(m.value);
      else if (m.type === "ready") hooks.ready();
      else if (m.type === "rpc") {
        if (queued >= LIMITS.pendingRequests) throw new Error("Too many pending host requests");
        queued++;
        // Serial host effects; accepted writes finish atomically, queued work is
        // discarded on stop. No result from an old run can enter the next worker.
        chain = chain.then(async () => {
          if (stopped) {
            queued--;
            return;
          }
          try {
            const value = await request(m.method, m.args);
            post({ type: "result", id: m.id, value });
          } catch (e) {
            post({
              type: "result",
              id: m.id,
              error: e instanceof Error ? e.message : String(e),
            });
          } finally {
            queued--;
          }
        });
      }
    } catch (e) {
      hooks.error(e instanceof Error ? e.message : String(e));
      stop();
    }
  }
  window.addEventListener("message", receive);
  container.append(frame);
  return {
    stop,
    event: (id: string, value = "") => post({ type: "event", id, value }),
  };
}
