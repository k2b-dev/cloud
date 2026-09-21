import { CODE_RUNTIME_TOOL_NAMES, type CodeRuntimeInput, parseCodeToolInput } from "@k2b/cloud/ai/browser";
import { type AiFrontendToolHandler, conversationFileSource } from "@k2b/cloud/ai/solid";
import { onCleanup } from "solid-js";
import { z } from "zod";
import { ChatPresentationResult } from "./chat-presentation-contracts";
import { artifactClient } from "./client";
import { LIMITS } from "./contracts";
import { type HttpHost, runHttp } from "./http-host";
import { AnalyticsEvent } from "./runtime/analytics-contracts";
import { inspectAnalytics } from "./runtime/analytics-inspect";
import { type ApproveCapability, runCapability } from "./runtime/capabilities";
import { type ArtifactSession, createArtifactSession } from "./runtime/session";
import { RuntimeStorage, sharedStorage } from "./runtime/shared-storage";
import { appTab, type WorkspaceTab } from "./workspace-state";

const Claim = z.discriminatedUnion("status", [
  z.object({ status: z.literal("execute") }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("interrupted") }),
  z.object({ status: z.literal("done"), result: z.json() }),
]);
type Entry = {
  code?: string;
  inputs: { path: string; version: number }[];
  session: ArtifactSession;
  container: HTMLElement;
  artifactId?: string;
  revision: number;
  conversationId: string;
  resourceId?: string;
  outputSchema?: z.ZodType;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: string, max = 1000) => (value.length > max ? `${value.slice(0, max)}…` : value);

function inspect(runId: string, entry: Entry, options: { nodeId?: string; offset: number; limit: number } = { offset: 0, limit: 20 }) {
  const state = entry.session.snapshot();
  const invalidOutput =
    entry.outputSchema &&
    state.status === "ready" &&
    !state.busy &&
    state.work?.status !== "running" &&
    !entry.outputSchema.safeParse(state.output).success;
  const output = state.output === undefined ? null : JSON.stringify(state.output);
  const { offset, limit, nodeId } = options;
  const selected = nodeId ? state.nodes.filter((node) => node.id === nodeId) : state.nodes.slice(offset, offset + limit);
  if (nodeId && !selected.length) throw new Error("UI node not found");
  return {
    userVisible: false,
    delivery: "Use code_present for a one-off visualization, code_export then present for files, or code_open for a saved app.",
    runId,
    id: entry.artifactId,
    revision: entry.artifactId ? entry.revision : undefined,
    resourceId: entry.resourceId,
    status: invalidOutput ? "error" : state.status,
    busy: state.busy,
    work: state.work,
    error: invalidOutput
      ? "Action output does not match its schema. Effects may have completed; inspect state before retrying."
      : state.error
        ? text(state.error, 6000)
        : null,
    modal: state.modal ? { ...state.modal, id: state.modalId } : null,
    totalNodes: state.nodes.length,
    nextNodeOffset: !nodeId && offset + limit < state.nodes.length ? offset + limit : null,
    nodes: selected.map((node) => ({ id: node.id, ...inspectAnalytics(node, offset, limit, Boolean(nodeId)) })),
    logs: state.logs.slice(-20).map((log) => ({ ...log, text: text(log.text, 2000) })),
    output: output === null ? null : text(output, 16000),
    outputTruncated: output !== null && output.length > 16000,
    files: state.files,
  };
}

export function createArtifactAgentRuntime(
  open: ((tab: WorkspaceTab) => void) | null,
  approve?: ApproveCapability,
  execution: "chat-tool" | "standalone" = "chat-tool",
  httpHost?: HttpHost,
) {
  const runs = new Map<string, Entry>();
  const clientId = crypto.randomUUID();
  const abort = new AbortController();
  onCleanup(() => {
    abort.abort();
    for (const entry of runs.values()) {
      void entry.session.stop();
      entry.container.remove();
    }
    runs.clear();
  });
  async function request(path: string, body: unknown) {
    const response = await fetch(`/api/assistant/artifacts/runtime/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
    });
    const result: unknown = await response.json();
    if (!response.ok)
      throw new Error(result && typeof result === "object" && "message" in result ? String(result.message) : `HTTP ${response.status}`);
    return result;
  }
  async function waitFor(entry: Entry, condition: () => boolean) {
    let deadline = Date.now() + 20000;
    while (!condition() || entry.session.snapshot().approvalPending) {
      if (entry.session.snapshot().approvalPending || entry.session.snapshot().inputPending) deadline = Date.now() + 20000;
      if (abort.signal.aborted) throw new Error("Browser workspace disconnected");
      if (Date.now() >= deadline) {
        await entry.session.stop();
        throw new Error("Test run timed out and was stopped");
      }
      await pause(20);
    }
  }
  async function execute(
    input: CodeRuntimeInput,
    conversationId: string,
    callId: string,
    signal: AbortSignal,
    invocation?: Awaited<ReturnType<typeof artifactClient.action>>,
  ): Promise<unknown> {
    if (input.operation === "action") {
      const { operation, ...request } = input;
      const prepared = await artifactClient.action(request, conversationId, signal);
      return execute({ operation: "run", id: input.id, inputPaths: [] }, conversationId, callId, signal, prepared);
    }
    if (input.operation === "secret") {
      if (!httpHost?.secret)
        throw new Error("Secret input requires the Assistant web UI. Configure personal secrets there before running CLI code.");
      return httpHost.secret(
        { resourceId: input.resourceId, conversationId },
        { name: input.name, origin: input.origin, header: input.header, prefix: input.prefix },
        signal,
      );
    }
    if (input.operation === "open") {
      const app = await artifactClient.get(input.id);
      signal.throwIfAborted();
      if (abort.signal.aborted) throw new Error("Browser workspace disconnected");
      if (!open) return { href: `/app/assistant/apps/${app.id}`, started: false };
      open(appTab(app.id, app.title));
      return { opened: app.id, started: false };
    }
    if (input.operation === "run") {
      if (runs.size >= LIMITS.pendingRequests) {
        for (const [id, entry] of runs) {
          const state = entry.session.snapshot();
          if (
            entry.artifactId ||
            state.status !== "ready" ||
            state.busy ||
            state.inputPending ||
            state.pendingRequests ||
            state.approvalPending ||
            state.modal ||
            state.nodes.length ||
            state.files.length ||
            state.work?.status === "running"
          )
            continue;
          // Under pressure reclaim only finished disposable runs. Captured exports
          // and any active effects belong to the caller until explicitly stopped.
          runs.delete(id);
          await entry.session.stop();
          entry.container.remove();
          break;
        }
        if (runs.size >= LIMITS.pendingRequests)
          throw new Error("Stop an existing test run before starting another; remaining runs hold active work or retained resources");
      }
      if (input.resourceId) await artifactClient.access(input.resourceId);
      const dataId = input.resourceId ?? input.id;
      const current =
        invocation?.resource ?? (input.id ? await artifactClient.get(input.id, false, input.version, conversationId) : undefined);
      const source = conversationFileSource("/api/ai", conversationId);
      const listed = input.inputPaths.length ? await source.listFiles() : [];
      const selected = input.inputPaths.map((path) => {
        const file = listed.find((file) => file.path === path);
        if (!file) throw new Error(`Input not found: ${path}`);
        return file;
      });
      if (selected.reduce((size, file) => size + (file.size ?? 0), 0) > LIMITS.inputBytes)
        throw new Error("Selected inputs exceed the 250 MiB chat-file budget");
      const inputFiles = selected.map((file) => ({ name: file.path, size: file.size ?? 0, type: file.mediaType ?? "" }));
      const readInput = async (path: string, readSignal: AbortSignal) => {
        const file = selected.find((file) => file.path === path);
        if (!file) throw new Error("Input was not selected for this run");
        const response = await fetch(
          `/api/ai/conversations/${encodeURIComponent(conversationId)}/files/content?${new URLSearchParams({ path: file.path, version: String(file.version) })}`,
          { signal: readSignal },
        );
        if (!response.ok) throw new Error(`Input could not be read: ${file.path} (HTTP ${response.status})`);
        const blob = await response.blob();
        readSignal.throwIfAborted();
        if (blob.size > LIMITS.inputFileBytes) throw new Error("Input exceeds the 50 MiB chat-file budget");
        const inputFile = new File([blob], file.path.split("/").pop()!, { type: blob.type });
        Object.defineProperty(inputFile, "webkitRelativePath", { value: file.path });
        return inputFile;
      };
      const pickerInputs = async (readSignal: AbortSignal) => {
        const files: File[] = [];
        for (const file of selected) files.push(await readInput(file.path, readSignal));
        return files;
      };
      const compiled =
        invocation?.compiled ??
        (current
          ? await artifactClient.compiled(current.id, current.sourceRevision, conversationId)
          : await artifactClient.compile({ entry: "main.ts", files: [{ path: "main.ts", content: input.code! }] }));
      signal.throwIfAborted();
      if (abort.signal.aborted) throw new Error("Browser workspace disconnected");
      const container = document.createElement("div");
      container.hidden = true;
      document.body.append(container);
      let session: ArtifactSession;
      try {
        session = createArtifactSession(container, compiled, {
          mode: "test",
          ai: (request, signal) => artifactClient.ai(request, { resourceId: dataId, conversationId }, signal),
          pdf: (request, signal) => artifactClient.pdf(request, { resourceId: dataId, conversationId }, signal),
          http: (request, signal) => {
            if (!httpHost) throw new Error("Server HTTP unavailable");
            return runHttp(request, { resourceId: dataId, conversationId }, httpHost, signal);
          },
          inputFiles: current?.kind === "app" ? [] : inputFiles,
          readInput,
          pickerInputs,
          changed: () => {},
          capability: (name, input, signal) => {
            if (!approve) throw new Error("Capability approval UI unavailable");
            return runCapability(name, input, { artifactId: current?.id, conversationId }, approve, signal);
          },
          database: async (request, signal) => {
            if (!dataId) throw new Error("Database access requires a saved resource or resourceId");
            return artifactClient.database(dataId, request, conversationId, signal, Boolean(input.resourceId));
          },
          storage: async (_method, args) => {
            if (!dataId) throw new Error("Shared storage requires a saved resource or resourceId");
            return sharedStorage(dataId, RuntimeStorage.parse(args[0]), conversationId, Boolean(input.resourceId));
          },
        });
      } catch (error) {
        container.remove();
        throw error;
      }
      const runId = callId;
      const entry = {
        code: input.code,
        inputs: selected.map(({ path, version }) => ({ path, version })),
        session,
        container,
        artifactId: input.id,
        resourceId: input.resourceId,
        revision: current?.sourceRevision ?? 0,
        conversationId,
        outputSchema: invocation ? z.fromJSONSchema(invocation.outputSchema) : undefined,
      };
      runs.set(runId, entry);
      await waitFor(entry, () => session.snapshot().status !== "starting" || session.snapshot().work?.status === "running");
      return inspect(runId, entry);
    }
    const entry = runs.get(input.runId);
    if (!entry || entry.conversationId !== conversationId)
      throw new Error("Test run is no longer available in this conversation host. Inspect saved effects before starting a new run.");
    // Re-check current permissions even when the test run was started earlier.
    if (entry.resourceId && input.operation !== "stop") await artifactClient.access(entry.resourceId);
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
      await entry.session.stop();
      entry.container.remove();
      runs.delete(input.runId);
      return { runId: input.runId, stopped: true };
    }
    if (input.operation === "interact") {
      const steps = input.steps ?? [{ id: input.id, event: input.event, answer: input.answer }];
      let completedSteps = 0;
      for (const step of steps) {
        if (!step.id) throw new Error("Interaction requires a control or modal ID");
        const state = entry.session.snapshot();
        if (state.modal && step.id === state.modalId) {
          if (step.event !== undefined || step.answer === undefined)
            throw new Error("This is a modal. Supply answer with the requested value, or null to cancel.");
          entry.session.respond(step.answer);
          await waitFor(entry, () => {
            const current = entry.session.snapshot();
            return (
              (current.status === "waiting" && current.modalId !== state.modalId) ||
              (!["starting", "waiting"].includes(current.status) && !current.busy)
            );
          });
        } else {
          if (step.answer !== undefined) throw new Error("This is a control. Supply event as an object, or omit it to activate a button.");
          const event = AnalyticsEvent.parse(step.event ?? { type: "change", value: null });
          let settled = false,
            failure: unknown;
          void entry.session.event({ id: step.id, event }).then(
            () => {
              settled = true;
            },
            (error) => {
              failure = error;
              settled = true;
            },
          );
          await waitFor(
            entry,
            () => settled || entry.session.snapshot().status === "waiting" || entry.session.snapshot().work?.status === "running",
          );
          if (failure) throw failure;
        }
        completedSteps++;
        const current = entry.session.snapshot();
        if (current.error || current.modal || current.work?.status === "running") break;
      }
      return { ...inspect(input.runId, entry), completedSteps, nextStep: completedSteps < steps.length ? completedSteps : null };
    } else if (input.operation === "present") {
      const state = entry.session.snapshot();
      if (!entry.code || entry.artifactId || entry.resourceId)
        throw new Error("Present a one-off code run without app data. Use code_open for a saved app.");
      if (
        state.status !== "ready" ||
        state.error ||
        state.busy ||
        state.inputPending ||
        state.approvalPending ||
        state.pendingRequests ||
        state.work?.status === "running" ||
        state.modal ||
        !state.nodes.length ||
        state.nodes.some((node) => node.loading || (node.type === "group" && node.error))
      )
        throw new Error("Wait for a successful, settled run with visible UI before presenting it.");
      const response = await fetch("/api/assistant/artifacts/presentations", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, callId, title: input.title, code: entry.code, nodes: state.nodes, inputs: entry.inputs }),
      });
      if (!response.ok) throw new Error(`Could not present visualization: HTTP ${response.status}`);
      return { ...ChatPresentationResult.parse(await response.json()), userVisible: true };
    } else if (input.operation === "export") {
      const file = entry.session.files().find((file) => file.name === input.name);
      if (!file) throw new Error("Captured output not found");
      const form = new FormData();
      form.append("file", file);
      form.append("directory", "/files");
      const response = await fetch(`/api/ai/conversations/${encodeURIComponent(conversationId)}/files`, {
        method: "POST",
        body: form,
        signal,
      });
      if (!response.ok) throw new Error(`Could not export ${file.name}: HTTP ${response.status}`);
      const stored = z.object({ file: z.object({ path: z.string(), version: z.number().int().positive() }) }).parse(await response.json());
      const result = { path: stored.file.path, version: stored.file.version, size: file.size, mediaType: file.type };
      return result;
    }
    return inspect(input.runId, entry, input.operation === "inspect" ? input : undefined);
  }

  const handler: AiFrontendToolHandler = async ({ name, args, callId, turnId, conversationId }) => {
    let input: CodeRuntimeInput;
    try {
      input = parseCodeToolInput(name, args);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      return {
        kind: "input",
        error: text(error.message, 6000),
        guidance: "Correct the tool arguments using its schema. The app source was not executed.",
      };
    }
    const call = { input, callId, turnId, conversationId, clientId };
    if (execution === "chat-tool") {
      let claim = Claim.parse(await request("claim", call));
      while (claim.status === "pending" && !abort.signal.aborted) {
        await pause(1000);
        claim = Claim.parse(await request("claim", call));
      }
      if (claim.status === "done") return claim.result;
      if (claim.status !== "execute")
        return {
          error: "Browser execution was interrupted. No action was replayed. Inspect effects before deliberately starting another run.",
        };
    }
    let result: unknown;
    const callAbort = new AbortController();
    const signal = AbortSignal.any([abort.signal, callAbort.signal]);
    // Renew while executing or awaiting approval; duplicate tabs only observe.
    let renewing = false,
      leaseUntil = Date.now() + 120000;
    const heartbeat =
      execution === "chat-tool"
        ? setInterval(async () => {
            if (renewing || abort.signal.aborted) return;
            renewing = true;
            try {
              const claim = Claim.parse(await request("claim", call));
              if (claim.status === "interrupted") leaseUntil = 0;
              else leaseUntil = Date.now() + 120000;
            } catch {
              /* A transient failure does not immediately lose the lease. */
            } finally {
              renewing = false;
              if (Date.now() >= leaseUntil) {
                callAbort.abort(new Error("Execution ownership expired; inspect effects before retrying"));
                const entry = runs.get(["run", "action"].includes(input.operation) ? callId : "runId" in input ? input.runId : "");
                if (entry) void entry.session.stop();
              }
            }
          }, 15000)
        : undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let operationDeadline = Date.now() + 45000;
    try {
      result = await Promise.race([
        execute(input, conversationId, callId, signal),
        new Promise((_, reject) => {
          timer = setInterval(() => {
            const entry = runs.get(["run", "action"].includes(input.operation) ? callId : "runId" in input ? input.runId : "");
            // Waiting for a human is not execution time. Keep the watchdog for
            // stalled work, but allow the user to consider an approval.
            if (entry?.session.snapshot().approvalPending) operationDeadline = Date.now() + 45000;
            if (input.operation === "secret" || Date.now() < operationDeadline) return;
            callAbort.abort();
            if (entry) void entry.session.stop();
            reject(new Error("Browser operation timed out. The test run was stopped; no operation was replayed."));
          }, 1000);
        }),
      ]);
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearInterval(timer);
      clearInterval(heartbeat);
    }
    // The model receives only bounded JSON, never Blob or Solid proxy objects.
    const encoded = JSON.stringify(result);
    const bounded: unknown =
      new TextEncoder().encode(encoded).byteLength <= 256 * 1024
        ? JSON.parse(encoded)
        : {
            runId: ["run", "action"].includes(input.operation) ? callId : "runId" in input ? input.runId : null,
            error: "Inspection exceeds 256 KiB. Use inspect with a nodeId and smaller limit.",
          };
    if (execution === "chat-tool") await request("complete", { ...call, result: bounded });
    return bounded;
  };
  const guarded: AiFrontendToolHandler = async (call) => {
    try {
      return await handler(call);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        kind: "host",
        retryable: false,
        guidance:
          "The browser host could not complete this call. Do not rewrite app source or repeat this unchanged call. Report the host error.",
      };
    }
  };
  return Object.fromEntries(CODE_RUNTIME_TOOL_NAMES.map((name) => [name, guarded]));
}
