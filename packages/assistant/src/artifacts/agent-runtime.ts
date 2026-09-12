import { runCapability, type ApproveCapability } from "./runtime/capabilities";
import { CODE_RUNTIME_TOOL_NAMES, parseCodeToolInput, type CodeRuntimeInput } from "@k2b/cloud/ai/browser";
import { conversationFileSource, type AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { onCleanup } from "solid-js";
import { z } from "zod";
import { artifactClient } from "./client";
import { RuntimeStorage, sharedStorage } from "./runtime/shared-storage";
import { LIMITS } from "./contracts";
import { createArtifactSession, type ArtifactSession } from "./runtime/session";
import { appTab, type WorkspaceTab } from "./workspace-state";

const Claim = z.discriminatedUnion("status", [
  z.object({ status: z.literal("execute") }), z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("interrupted") }), z.object({ status: z.literal("done"), result: z.json() }),
]);
type Entry = { session: ArtifactSession; container: HTMLElement; artifactId?: string; revision: number; conversationId: string };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: string, max = 1000) => value.length > max ? `${value.slice(0, max)}…` : value;

function inspect(runId: string, entry: Entry, options: { nodeId?: string; offset: number; limit: number } = { offset: 0, limit: 20 }) {
  const state = entry.session.snapshot();
  const { offset, limit, nodeId } = options;
  const selected = nodeId ? state.nodes.filter((node) => node.id === nodeId) : state.nodes.slice(offset, offset + limit);
  if (nodeId && !selected.length) throw new Error("UI node not found");
  return {
    runId, id: entry.artifactId, status: state.status, busy: state.busy, work: state.work,
    error: state.error ? text(state.error, 6000) : null, modal: state.modal ? { ...state.modal, id: state.modalId } : null,
    totalNodes: state.nodes.length, nextNodeOffset: !nodeId && offset + limit < state.nodes.length ? offset + limit : null,
    nodes: selected.map((node) => ({
      id: node.id, kind: node.kind, label: text(node.label, 250), value: text(node.value, 500), disabled: node.disabled, loading: node.loading,
      description: text(node.description, 1000), state: node.state, children: node.children, actions: node.actions.map((action) => ({ ...action, label: text(action.label, 120) })),
      ...(node.kind === "select" ? { options: nodeId ? node.options.slice(offset, offset + limit).map((option) => ({ value: option.value, label: text(option.label, 250) })) : [], totalOptions: node.options.length } : {}),
      ...(node.kind === "list" ? { items: node.items.slice(nodeId ? offset : 0, nodeId ? offset + limit : 3).map((item) => ({ id: item.id, title: text(item.title, 250) })), totalItems: node.items.length } : {}),
      ...(node.kind === "table" ? { columns: node.columns, rows: nodeId ? node.rows.slice(offset, offset + limit) : [], totalRows: node.rows.length } : {}),
    })),
    logs: state.logs.slice(-20).map((log) => ({ ...log, text: text(log.text, 2000) })),
    output: state.output === undefined ? null : text(JSON.stringify(state.output), 16000), files: state.files,
  };
}

export function createArtifactAgentRuntime(open: ((tab: WorkspaceTab) => void) | null, approve?: ApproveCapability, execution: "chat-tool" | "standalone" = "chat-tool") {
  const runs = new Map<string, Entry>();
  const clientId = crypto.randomUUID();
  const abort = new AbortController();
  onCleanup(() => {
    abort.abort();
    for (const entry of runs.values()) { void entry.session.stop(); entry.container.remove(); }
    runs.clear();
  });
  async function request(path: string, body: unknown) {
    const response = await fetch(`/api/assistant/artifacts/runtime/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error(result && typeof result === "object" && "message" in result ? String(result.message) : `HTTP ${response.status}`);
    return result;
  }
  async function waitFor(entry: Entry, condition: () => boolean) {
    let deadline = Date.now() + 20000;
    while (!condition() || entry.session.snapshot().approvalPending) {
      if(entry.session.snapshot().approvalPending)deadline=Date.now()+20000;
      if (abort.signal.aborted) throw new Error("Browser workspace disconnected");
      if (Date.now() >= deadline) { await entry.session.stop(); throw new Error("Test run timed out and was stopped"); }
      await pause(20);
    }
  }
  async function execute(input: CodeRuntimeInput, conversationId: string, callId: string, signal: AbortSignal) {
    if (input.operation === "open") {
      const app = await artifactClient.get(input.id);
      signal.throwIfAborted();
      if (abort.signal.aborted) throw new Error("Browser workspace disconnected");
      if (app.kind !== "app") throw new Error("Scripts run with code_run; only GUI apps open in the app panel.");
      if (!open) return { href: `/app/assistant/apps/${app.id}`, started: false };
      open(appTab(app.id, app.title));
      return { opened: app.id, started: false };
    }
    if (input.operation === "run") {
      if (runs.size >= LIMITS.pendingRequests) throw new Error("Stop an existing test run before starting another");
      const current = input.id ? await artifactClient.get(input.id, false, input.version, conversationId) : undefined;
      const source = conversationFileSource("/api/ai", conversationId);
      const listed = input.inputPaths.length ? await source.list() : [];
      const selected = input.inputPaths.map((path) => {
        const file = listed.find((file) => file.path === path);
        if (!file) throw new Error(`Input not found: ${path}`);
        return file;
      });
      if (selected.reduce((size,file)=>size+(file.size??0),0)>LIMITS.inputBytes) throw new Error("Selected inputs exceed the 250 MiB chat-file budget");
      const inputFiles=selected.map(file=>({name:file.path,size:file.size??0,type:file.mediaType??""}));
      const readInput=async(path:string,readSignal:AbortSignal)=>{
        const file=selected.find(file=>file.path===path);
        if(!file)throw new Error("Input was not selected for this run");
        const response=await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}/files/content?${new URLSearchParams({path:file.path})}`,{signal:readSignal});
        if(!response.ok)throw new Error(`Input could not be read: ${file.path} (HTTP ${response.status})`);
        const blob=await response.blob();
        readSignal.throwIfAborted();
        if(blob.size>LIMITS.inputFileBytes)throw new Error("Input exceeds the 50 MiB chat-file budget");
        const inputFile=new File([blob],file.path.split("/").pop()!,{type:blob.type});
        Object.defineProperty(inputFile,"webkitRelativePath",{value:file.path});
        return inputFile;
      };
      const pickerInputs=async(readSignal:AbortSignal)=>{
        const files:File[]=[];
        for(const file of selected)files.push(await readInput(file.path,readSignal));
        return files;
      };
      const compiled = current
        ? await artifactClient.compiled(current.id, current.sourceRevision, conversationId)
        : await artifactClient.compile({entry:"main.ts",files:[{path:"main.ts",content:input.code!}]});
      signal.throwIfAborted();
      if (abort.signal.aborted) throw new Error("Browser workspace disconnected");
      const container = document.createElement("div"); container.hidden = true; document.body.append(container);
      let session: ArtifactSession;
      try {
        session = createArtifactSession(container, compiled, { mode: "test", inputFiles: current?.kind === "app" ? [] : inputFiles, readInput, pickerInputs, changed: () => {}, capability: (name,input,signal) => {
          if(!approve)throw new Error("Capability approval UI unavailable");
          return runCapability(name,input,{artifactId:current?.id,conversationId},approve,signal);
        }, database: async (request,signal) => {
          if (!current) throw new Error("Database access requires a saved app or script");
          return artifactClient.database(current.id,request,conversationId,signal);
        }, storage: async (_method,args) => {
          if (!current) throw new Error("Shared storage requires a saved app or script");
          return sharedStorage(current.id,RuntimeStorage.parse(args[0]),conversationId);
        } });
      } catch (error) {
        container.remove();
        throw error;
      }
      const runId = callId;
      const entry = { session, container, artifactId: input.id, revision: current?.sourceRevision ?? 0, conversationId };
      runs.set(runId, entry);
      await waitFor(entry, () => session.snapshot().status !== "starting" || session.snapshot().work?.status === "running");
      return inspect(runId, entry);
    }
    const entry = runs.get(input.runId);
    if (!entry || entry.conversationId !== conversationId) throw new Error("Test run is no longer available in this chat/browser. Start a new run.");
    // Re-check current permissions even when the test run was started earlier.
    if (entry.artifactId) await artifactClient.get(entry.artifactId, false, undefined, conversationId);
    signal.throwIfAborted();
    if (input.operation === "inspect" && input.waitMs) {
      const until = Date.now() + input.waitMs;
      while (entry.session.snapshot().work?.status === "running" && Date.now() < until) {
        signal.throwIfAborted();
        if (entry.session.snapshot().modal || entry.session.snapshot().approvalPending) break;
        await pause(100);
      }
    }
    if (input.operation === "stop") {
      await entry.session.stop(); entry.container.remove(); runs.delete(input.runId);
      return { runId: input.runId, stopped: true };
    }
    if (input.operation === "interact") {
      const state = entry.session.snapshot();
      if (state.modal && input.id === state.modalId) {
        entry.session.respond(input.value);
        await waitFor(entry, () => {
          const current = entry.session.snapshot();
          return (current.status === "waiting" && current.modalId !== state.modalId)
            || (!["starting", "waiting"].includes(current.status) && !current.busy);
        });
      } else {
        if (input.value !== undefined && typeof input.value !== "string") throw new Error("Control values must be strings; use the modal ID for structured answers");
        let settled = false, failure: unknown;
        void entry.session.event({ id: input.id, value: input.value, action: input.action, item: input.item })
          .then(() => { settled = true; }, (error) => { failure = error; settled = true; });
        await waitFor(entry, () => settled || entry.session.snapshot().status === "waiting" || entry.session.snapshot().work?.status === "running");
        if (failure) throw failure;
      }
    } else if (input.operation === "export") {
      const file = entry.session.files().find((file) => file.name === input.name);
      if (!file) throw new Error("Captured output not found");
      const path = `artifact-${input.runId.replace(/[^a-zA-Z0-9]/g, "").slice(-20)}-${file.name}`;
      const source = conversationFileSource("/api/ai", conversationId);
      if (!source.upload) throw new Error("Chat file upload unavailable");
      await source.upload("/", [new File([file], path, { type: file.type })]);
      return { path: `/${path}`, size: file.size, mediaType: file.type };
    }
    return inspect(input.runId, entry, input.operation === "inspect" ? input : undefined);
  }

  const handler: AiFrontendToolHandler = async ({ name, args, callId, turnId, conversationId }) => {
    const input = parseCodeToolInput(name, args);
    const call = { input, callId, turnId, conversationId, clientId };
    if (execution === "chat-tool") {
      let claim = Claim.parse(await request("claim", call));
      while (claim.status === "pending" && !abort.signal.aborted) {
        await pause(1000);
        claim = Claim.parse(await request("claim", call));
      }
      if (claim.status === "done") return claim.result;
      if (claim.status !== "execute") return { error: "Browser execution was interrupted. No action was replayed. Inspect effects before deliberately starting another run." };
    }
    let result: unknown;
    const callAbort = new AbortController();
    const signal = AbortSignal.any([abort.signal, callAbort.signal]);
    // Renew while executing or awaiting approval; duplicate tabs only observe.
    let renewing = false, leaseUntil = Date.now() + 120000;
    const heartbeat = execution === "chat-tool" ? setInterval(async () => {
      if (renewing || abort.signal.aborted) return;
      renewing = true;
      try {
        const claim = Claim.parse(await request("claim", call));
        if (claim.status === "interrupted") leaseUntil = 0;
        else leaseUntil = Date.now() + 120000;
      } catch { /* A transient failure does not immediately lose the lease. */ }
      finally {
        renewing = false;
        if (Date.now() >= leaseUntil) {
          callAbort.abort(new Error("Execution ownership expired; inspect effects before retrying"));
          const entry = runs.get(input.operation === "run" ? callId : "runId" in input ? input.runId : "");
          if (entry) void entry.session.stop();
        }
      }
    }, 15000) : undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let operationDeadline = Date.now() + 45000;
    try {
      result = await Promise.race([
        execute(input, conversationId, callId, signal),
        new Promise((_, reject) => { timer = setInterval(() => {
          const entry = runs.get(input.operation === "run" ? callId : "runId" in input ? input.runId : "");
          // Waiting for a human is not execution time. Keep the watchdog for
          // stalled work, but allow the user to consider an approval.
          if (entry?.session.snapshot().approvalPending) operationDeadline = Date.now() + 45000;
          if (Date.now() < operationDeadline) return;
          callAbort.abort();
          if (entry) void entry.session.stop();
          reject(new Error("Browser operation timed out. The test run was stopped; no operation was replayed."));
        }, 1000); }),
      ]);
    }
    catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
    finally { clearInterval(timer); clearInterval(heartbeat); }
    // The model receives only bounded JSON, never Blob or Solid proxy objects.
    const encoded = JSON.stringify(result);
    const bounded: unknown = new TextEncoder().encode(encoded).byteLength <= 256 * 1024
      ? JSON.parse(encoded) : { runId: input.operation === "run" ? callId : "runId" in input ? input.runId : null, error: "Inspection exceeds 256 KiB. Use inspect with a nodeId and smaller limit." };
    if (execution === "chat-tool") await request("complete", { ...call, result: bounded });
    return bounded;
  };
  const guarded: AiFrontendToolHandler = async (call) => {
    try { return await handler(call); }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error), kind: "host", retryable: false, guidance: "The browser host could not complete this call. Do not rewrite app source or repeat this unchanged call. Report the host error." };
    }
  };
  return Object.fromEntries(CODE_RUNTIME_TOOL_NAMES.map((name) => [name, guarded]));
}
