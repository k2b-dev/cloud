import { authorizeCodeExecution, type createCodeCapabilityTransport, parseCodeToolInput } from "@k2b/cloud/ai";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { type ChatRunInput, ChatRunPollSchema, type ChatRunReplySchema, decodeChatValue, encodeChatValue } from "@k2b/cloud/code/chat-run";
import { CapabilityStreamSchema } from "@k2b/cloud/contracts";
import { z } from "zod";
import { runtimeCapabilities } from "./capability-runtime";
import type { CodeToolContext } from "./context";
import { LIMITS } from "./contracts";
import { HttpRequest, HttpResult, HttpReview } from "./http-contracts";
import { encodePdfRequest } from "./pdf-contracts";
import type { CapabilityDecision, CodeApproval } from "./runtime/capabilities";
import { codeRunSdk, usesCodeRunSdk } from "./runtime/code-run-sdk";
import { CloudError, cloudError } from "./runtime/errors";
import type { RuntimeHooks } from "./runtime/host";
import { WorkerMessage } from "./runtime/protocol";
import { inspectCodeRun } from "./runtime/run-result";
import { compileRunnerScript } from "./runtime/runner-compile";
import { type ArtifactSession, createArtifactSession } from "./runtime/session";
import { runStream } from "./runtime/streams";
import { ViewRefSchema } from "./runtime/views";

type Call = Parameters<AiFrontendToolHandler>[0];
type Options = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  transport: ReturnType<typeof createCodeCapabilityTransport>;
  current: () => { context: CodeToolContext; turnId: string };
  approve: (request: CodeApproval, signal?: AbortSignal) => Promise<CapabilityDecision>;
  /** Fixture seam replaces only allocation/transport; the script and tool host remain real. */
  start?: (input: ChatRunInput, hooks: RuntimeHooks, signal: AbortSignal) => Promise<void>;
};
const pause = (ms = 25) => Bun.sleep(ms);
const checked = async (response: Response) => {
  if (!response.ok) {
    const error = z
      .object({ message: z.string().optional(), code: z.string().optional() })
      .catch({})
      .parse(await response.json().catch(() => null));
    throw Object.assign(new Error(error.message ?? error.code ?? `HTTP ${response.status}`), { code: error.code });
  }
  return response;
};
export async function handleRunnerMessage(operation: string, input: unknown, hooks: RuntimeHooks, signal: AbortSignal) {
  if (operation !== "chat.message") throw new Error("Unknown script bridge operation");
  const message = WorkerMessage.parse(decodeChatValue(input));
  let value: unknown = null;
  switch (message.type) {
    case "rpc":
      value = await hooks.request(message.method, message.args, signal);
      break;
    case "work":
      hooks.work?.(message);
      break;
    case "log":
      hooks.log(message.level, message.text);
      break;
    case "output":
      hooks.output(message.value);
      break;
    case "error":
      hooks.error(message.text);
      break;
    case "ready":
      hooks.ready();
      break;
    case "cancel":
      break;
  }
  return encodeChatValue(value);
}

/** Server-only one-off host. Reuses the script session, outputs and turn approval services without a browser. */
export function createRunnerCodeHost(options: Options) {
  const runs = new Map<string, { session: ArtifactSession; revision: number }>();
  const lifetime = new AbortController();
  const request = async (path: string, body: unknown, signal?: AbortSignal) =>
    checked(
      await options.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  const core = async (path: string, body: unknown, signal?: AbortSignal) =>
    checked(
      await options.transport(
        new Request(`http://core.invalid/api/code-runner/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      ),
    );
  async function remoteStart(
    input: ChatRunInput,
    hooks: RuntimeHooks,
    signal: AbortSignal,
    bindGuard: (guard: () => Promise<void>) => void,
  ) {
    const { id, deadlineAt } = z.object({ id: z.uuid(), deadlineAt: z.number() }).parse(await (await core("start", input, signal)).json());
    signal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
    hooks.pending?.(1);
    try {
      while (!signal.aborted) {
        const poll = ChatRunPollSchema.parse(await (await core(`${id}/poll`, {}, signal)).json());
        for (const call of poll.calls) {
          hooks.pending?.(0);
          bindGuard(async () => {
            signal.throwIfAborted();
            const { active } = z.object({ active: z.boolean() }).parse(await (await core(`${id}/status`, { id: call.id }, signal)).json());
            if (!active) throw new CloudError("cancelled", "Code runner attempt ended. Inspect effects before starting again.");
          });
          let result: z.infer<typeof ChatRunReplySchema>;
          try {
            result = { ok: true, value: await handleRunnerMessage(call.operation, call.input, hooks, signal) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof CloudError ? error.code : undefined;
            result = { ok: false, error: { message: message.slice(0, LIMITS.text), ...(code ? { code } : {}) } };
          }
          await core(`${id}/resolve`, { id: call.id, result }, signal);
        }
        if (!["running", "queued"].includes(poll.state)) {
          const result = z.object({ kind: z.string(), outcome: z.string().optional(), code: z.string().optional() }).safeParse(poll.result);
          if (poll.state !== "succeeded" || !result.success || result.data.outcome !== "succeeded")
            throw new Error(
              result.success ? (result.data.code ?? `Code runner: ${result.data.outcome ?? poll.state}`) : "Code runner result unavailable",
            );
          return;
        }
        await pause(100);
      }
      signal.throwIfAborted();
    } finally {
      await core(`${id}/cancel`, {}, AbortSignal.timeout(10_000)).catch(() => {});
    }
  }
  async function execute(call: Call) {
    const input = parseCodeToolInput(call.name, call.args);
    const { context, turnId } = options.current();
    const conversationId = context.conversationId!;
    const scope = { conversationId };
    if (input.operation === "run") {
      if (runs.size >= LIMITS.pendingRequests) {
        for (const [id, entry] of runs) {
          const state = entry.session.snapshot();
          if (
            state.status !== "ready" ||
            state.inputPending ||
            state.pendingRequests ||
            state.approvalPending ||
            state.files.length ||
            state.views.length ||
            state.work?.status === "running"
          )
            continue;
          runs.delete(id);
          await entry.session.stop();
          break;
        }
        if (runs.size >= LIMITS.pendingRequests)
          throw new Error("Stop an existing test run before starting another; remaining runs hold active work or retained resources");
      }

      const source = { entry: "main.ts", files: [{ path: "main.ts", content: input.code }] };
      const sdk = usesCodeRunSdk(source.files) ? await codeRunSdk(context.authority ?? null, context.locale, lifetime.signal) : undefined;
      const compiled = await compileRunnerScript(source, sdk);
      const list = input.inputPaths.length
        ? z
            .object({ files: z.array(z.object({ path: z.string(), size: z.number(), mediaType: z.string(), version: z.number() })) })
            .parse(await (await checked(await options.fetch(`/api/ai/conversations/${conversationId}/files`))).json()).files
        : [];
      const files = input.inputPaths.map((path) => {
        const file = list.find((file) => file.path === path);
        if (!file) throw new Error(`Input not found: ${path}`);
        return file;
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      let completed: Promise<void>;
      let assertActive = async () => {};
      const session = createArtifactSession(
        null,
        { runtime: "", code: "" },
        {
          changed: () => {},
          inputFiles: files.map((file) => ({ name: file.path, size: file.size, type: file.mediaType })),
          readInput: async (path, signal) => {
            const file = files.find((file) => file.path === path);
            if (!file) throw new Error("Input was not selected for this run");
            const response = await checked(
              await options.fetch(
                `/api/ai/conversations/${conversationId}/files/content?${new URLSearchParams({ path, version: String(file.version) })}`,
                { signal },
              ),
            );
            return new File([await response.blob()], path.split("/").pop()!, { type: file.mediaType });
          },
          capability: async (name, input, signal, coordinates) => {
            const { context, turnId } = options.current();
            if (context.actor.kind !== "user") throw new Error("User required");
            const { config } = await authorizeCodeExecution(conversationId, turnId, context.actor.user.id);
            const caller = {
              transport: async (request: Request) => {
                await assertActive();
                return options.transport(request);
              },
              origin: "assistant" as const,
              locale: context.locale,
              signal,
            };
            const callId = crypto.randomUUID();
            let response = await runtimeCapabilities.prepare(
              {
                id: callId,
                name,
                input: z.json().parse(input),
                ...coordinates,
                conversationId,
              },
              context,
              caller,
              config.mandate ? { turnId, mandate: config.mandate } : undefined,
            );
            if (response.status === "approval") {
              const id = response.id;
              try {
                const decision = await options.approve(response, signal);
                signal.throwIfAborted();
                await assertActive();
                response = await runtimeCapabilities.resolve(id, decision, context, caller);
              } catch (error) {
                await runtimeCapabilities.resolve(id, { approved: false }, context, caller).catch(() => {});
                throw error;
              }
            }
            if (response.status !== "completed") throw new CloudError("denied", "Capability Action was rejected by the user.");
            const envelope = z
              .object({
                ok: z.boolean(),
                data: z.unknown().optional(),
                error: z.object({ message: z.string(), code: z.string() }).passthrough().optional(),
              })
              .parse(response.result);
            if (!envelope.ok) throw envelope.error ? cloudError(envelope.error) : new CloudError("unavailable", "Capability failed");
            const streamed = z.object({ stream: CapabilityStreamSchema }).passthrough().safeParse(envelope.data);
            if (streamed.success) return { ...streamed.data, stream: { ...streamed.data.stream, callId } };
            return envelope.data;
          },
          stream: (ref, verb, body, signal) => runStream(ref, verb, body, signal, options.fetch),
          http: async (value, signal) => {
            const id = crypto.randomUUID();
            const review = HttpReview.parse(
              await (
                await request(
                  "/api/assistant/chat-code/runtime/http",
                  { id, createdAt: Date.now(), scope, request: HttpRequest.parse(value) },
                  signal,
                )
              ).json(),
            );
            try {
              const { approved } = await options.approve(
                { ...review, type: "http", name: `http.fetch:${new URL(review.url).origin}` },
                signal,
              );
              signal.throwIfAborted();
              await assertActive();
              return HttpResult.parse(await (await request(`/api/assistant/chat-code/runtime/http/${id}`, { approved }, signal)).json());
            } catch (error) {
              await request(`/api/assistant/chat-code/runtime/http/${id}`, { approved: false }).catch(() => {});
              throw error;
            }
          },
          ai: async (requestInput, signal) =>
            z
              .object({ output: z.json() })
              .parse(await (await request("/api/assistant/chat-code/runtime/ai", { scope, request: requestInput }, signal)).json()).output,
          pdf: async (value, signal) =>
            (
              await checked(
                await options.fetch(`/api/assistant/chat-code/runtime/pdf?${new URLSearchParams(scope)}`, {
                  method: "POST",
                  body: encodePdfRequest(value),
                  signal,
                }),
              )
            ).blob(),
          view: async (view, index, signal) =>
            ViewRefSchema.parse(
              await (
                await request("/api/assistant/chat-code/runtime/views", { conversationId, turnId, runId: call.callId, index, view }, signal)
              ).json(),
            ),
        },
        (hooks) => {
          completed = (
            options.start ??
            ((input, hooks, signal) =>
              remoteStart(input, hooks, signal, (guard) => {
                assertActive = guard;
              }))
          )(
            {
              ...compiled,
              context: {
                locale: context.locale,
                timeZone: context.timeZone,
                user: context.actor.kind === "user" ? { id: context.actor.user.id, name: context.actor.user.displayName } : null,
              },
              files: files.map((file) => ({ path: file.path, size: file.size, type: file.mediaType })),
            },
            hooks,
            signal,
          )
            .then(() => {
              if (!signal.aborted && session.snapshot().status === "starting")
                hooks.error("Code runner returned no terminal script result");
            })
            .catch((error) => {
              if (!signal.aborted) hooks.error(error instanceof Error ? error.message : String(error));
            });
          return {
            stop: async () => {
              controller.abort();
              await completed;
            },
          };
        },
      );
      const entry = { session, revision: 0 };
      runs.set(call.callId, entry);
      while (session.snapshot().status === "starting" && session.snapshot().work?.status !== "running") {
        lifetime.signal.throwIfAborted();
        await pause();
      }
      return inspectCodeRun(call.callId, entry);
    }
    if (!("runId" in input)) throw new Error("This operation requires a run ID");
    const entry = runs.get(input.runId);
    if (!entry) throw new Error("Test run is no longer available. Inspect saved effects before starting a new run.");
    if (input.operation === "stop") {
      await entry.session.stop();
      runs.delete(input.runId);
      return { runId: input.runId, stopped: true };
    }
    if (input.operation === "export") {
      const file = entry.session.files().find((file) => file.name === input.name);
      if (!file) throw new Error("Captured output not found");
      const form = new FormData();
      form.append("file", file);
      form.append("directory", "/files");
      const stored = z
        .object({ file: z.object({ path: z.string(), version: z.number() }) })
        .parse(
          await (
            await checked(await options.fetch(`/api/ai/conversations/${conversationId}/files`, { method: "POST", body: form }))
          ).json(),
        );
      return { ...stored.file, size: file.size, mediaType: file.type };
    }
    if (input.operation === "inspect" && input.waitMs) {
      const until = Date.now() + input.waitMs;
      while (entry.session.snapshot().work?.status === "running" && Date.now() < until && !entry.session.snapshot().approvalPending)
        await pause();
    }
    return inspectCodeRun(input.runId, entry);
  }
  return {
    has: (runId: string) => runs.has(runId),
    execute: async (call: Call) => {
      try {
        return await execute(call);
      } catch (error) {
        return { failed: true, error: (error instanceof Error ? error.message : String(error)).slice(0, 6000) };
      }
    },
    health: async () => {},
    close: async () => {
      lifetime.abort();
      await Promise.all([...runs.values()].map((entry) => entry.session.stop()));
      runs.clear();
    },
  };
}
