import type { WorkState } from "./work";
import { LIMITS } from "../contracts";
import { RuntimeEvent, WorkerMessage, type UiNode } from "./protocol";
import { sandboxDocument } from "./sandbox";

export type RuntimeHooks = {
  work?: (state: WorkState) => void;
  pending?: (count: number) => void;
  ui: (nodes: UiNode[]) => void;
  log: (level: string, text: string) => void;
  error: (message: string) => void;
  output: (value: unknown) => void;
  busy: (value: boolean) => void;
  ready: () => void;
  request: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>;
};

export function validateTree(nodes: UiNode[]) {
  const by = new Map(nodes.map((node) => [node.id,node]));
  if (by.size !== nodes.length) throw new Error("Duplicate UI ids");
  const parents = new Set<string>();
  for (const node of nodes) {
    if (node.children.length && !["row","column","section","workbench"].includes(node.kind) && node.analytics?.type !== "layout") throw new Error("Invalid layout children");
    if (node.kind === "analytics" && (!node.analytics || node.analytics.id !== node.id || JSON.stringify(node.children) !== JSON.stringify(node.analytics.type === "layout" ? node.analytics.children : []))) throw new Error("Invalid analytics node envelope");
    if (node.kind === "workbench") {
      const expected = [...node.controls,...node.content,...(node.footer?.status ? [node.footer.status] : []),...(node.footer?.actions ?? [])];
      if (JSON.stringify(expected) !== JSON.stringify(node.children)) throw new Error("Invalid workbench references");
    }
    if (new Set(node.items.map((item) => item.id)).size !== node.items.length) throw new Error("Duplicate list item ids");
    if (new Set(node.actions.map((action) => action.id)).size !== node.actions.length) throw new Error("Duplicate action ids");
    for (const id of node.children) {
      if (!by.has(id) || parents.has(id)) throw new Error("Missing or multiply owned UI child");
      parents.add(id);
    }
  }
  const seen = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Cyclic UI tree");
    if (seen.has(id)) return;
    visiting.add(id);
    for (const child of by.get(id)!.children) visit(child);
    visiting.delete(id); seen.add(id);
  };
  for (const id of by.keys()) visit(id);
  const workbenches = nodes.filter((node) => node.kind === "workbench");
  if (workbenches.length > 1 || workbenches.some((node) => parents.has(node.id))) throw new Error("Workbench must be a single root layout");
}

export function startArtifactRun(container: HTMLElement, source: { runtime: string; code: string }, hooks: RuntimeHooks) {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.hidden = true;
  frame.title = "Isolated artifact runtime";
  frame.srcdoc = sandboxDocument();
  const abort = new AbortController();
  let stopped = false, windowStart = Date.now(), messages = 0, queued = 0, eventId = 0;
  let chain = Promise.resolve();
  let waitingForModal = false;
  let workWatchdog: ReturnType<typeof setTimeout> | undefined;
  const events = new Map<number,{ resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>; expire: () => void; timeoutMs: number }>();
  const post = (message: unknown) => { if (!stopped) frame.contentWindow?.postMessage(message,"*"); };
  const stop = () => {
    if (stopped) return chain;
    post({ type: "stop" });
    stopped = true;
    clearTimeout(workWatchdog);
    abort.abort();
    window.removeEventListener("message",receive);
    frame.remove();
    for (const event of events.values()) { clearTimeout(event.timer); event.reject(new Error("Run stopped")); }
    events.clear();
    hooks.busy(false);
    return chain;
  };
  function receive(event: MessageEvent) {
    if (stopped || event.source !== frame.contentWindow) return;
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); messages = 0; }
    try {
      // Same per-second transport budget as Kit, independently enforced here.
      if (++messages > 600) throw new Error("Run exceeded message budget");
      if (event.data?.type === "bridge-ready") { post({ type: "boot",...source }); return; }
      const encoded = JSON.stringify(event.data);
      if (!encoded || new TextEncoder().encode(encoded).byteLength > LIMITS.rpcBytes) throw new Error("Runtime message exceeds byte budget");
      const m = WorkerMessage.parse(event.data);
      if (m.type === "ui") { validateTree(m.nodes); hooks.ui(m.nodes); }
      else if (m.type === "log") hooks.log(m.level,m.text);
      else if (m.type === "error") hooks.error(m.text);
      else if (m.type === "output") hooks.output(m.value);
      else if (m.type === "busy") hooks.busy(m.value);
      else if (m.type === "ready") hooks.ready();
      else if (m.type === "work") {
        clearTimeout(workWatchdog);
        if (m.status === "running") {
          workWatchdog = setTimeout(() => { hooks.error("Background worker stopped responding; run stopped"); void stop(); }, 15000);
          if (!waitingForModal) for (const event of events.values()) { clearTimeout(event.timer); event.timer=setTimeout(event.expire,event.timeoutMs); }
        }
        const {type,...state}=m;
        hooks.work?.(state);
      }
      else if (m.type === "settled") {
        const pending = events.get(m.id);
        if (pending) { clearTimeout(pending.timer); events.delete(m.id); m.error ? pending.reject(new Error(m.error)) : pending.resolve(); }
      } else if (m.type === "rpc") {
        if (queued >= LIMITS.pendingRequests) throw new Error("Too many pending host requests");
        queued++;
        hooks.pending?.(queued);
        chain = chain.then(async () => {
          try {
            if (stopped) return;
            if (["http.fetch","database","storage","ui.modal","file.read","file.open","file.openMultiple","file.openFolder","capabilities.run"].includes(m.method)) {
              waitingForModal = true;
              for (const event of events.values()) clearTimeout(event.timer);
            }
            const value = await hooks.request(m.method,m.args,abort.signal);
            post({ type: "result",id: m.id,value });
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.slice(0,128) : undefined;
            post({ type: "result",id: m.id,error: String(error instanceof Error ? error.message : error).slice(0,LIMITS.text),code });
          } finally {
            if (["http.fetch","database","storage","ui.modal","file.read","file.open","file.openMultiple","file.openFolder","capabilities.run"].includes(m.method)) {
              waitingForModal = false;
              if (!stopped) for (const event of events.values()) event.timer = setTimeout(event.expire, event.timeoutMs);
            }
            queued--;
            hooks.pending?.(queued);
          }
        });
      }
    } catch (error) {
      hooks.error(String(error instanceof Error ? error.message : error).slice(0,LIMITS.text));
      void stop();
    }
  }
  window.addEventListener("message",receive);
  container.append(frame);
  return {
    stop,
    get stopped() { return stopped; },
    event: (input: RuntimeEvent, timeoutMs = 15000): Promise<void> => {
      if (stopped) return Promise.reject(new Error("Run stopped"));
      if (events.size >= LIMITS.pendingRequests) return Promise.reject(new Error("Too many pending interactions"));
      const parsed = RuntimeEvent.parse(input), id = eventId++;
      return new Promise((resolve,reject) => {
        const expire = () => {
          events.delete(id);
          reject(new Error("Interaction timed out; the run was stopped"));
          void stop();
        };
        const timer = waitingForModal ? undefined : setTimeout(expire, timeoutMs);
        events.set(id,{ resolve,reject,timer,expire,timeoutMs });
        post({ type: "event",...parsed,requestId: id });
      });
    },
  };
}
