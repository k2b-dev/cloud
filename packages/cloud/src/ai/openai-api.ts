import { estimateTokens, type Message, type Provider } from "@k2b/nessi";
import type { GenerateRequest, StreamEvent, Usage } from "@k2b/nessi/ai";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { type AuthContext, getLocale, rateLimit } from "../server";
import { REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "../server/request-timeout";
import { authenticateModelsOnlyCredential } from "../services/identity/models-only-auth";
import { coreSettings } from "../services/settings/api";
import { listAssistantAiModels } from "./assistant-models";
import { type OpenAiErrorCode, openAiApiMessages } from "./openai-api-messages";
import { acquire } from "./openai-api-slots";
import { personalAiModelPolicy } from "./personal-agent";
import { PROVIDER_TIMEOUTS } from "./provider";
import { inferenceProvider } from "./quota-provider";
import { AiQuotaError } from "./quotas";
import { resolveAiModel } from "./settings";

// Leave time for the provider's silence timeout to reach the client as a 502 JSON error.
const PROVIDER_WAIT_SECONDS = Math.ceil(Math.max(PROVIDER_TIMEOUTS.firstByteMs, PROVIDER_TIMEOUTS.idleMs) / 1000) + 10;

type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "insufficient_quota"
  | "rate_limit_error"
  | "api_error";
type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 502;
const errorBody = (c: Context<AuthContext>, code: OpenAiErrorCode, type: ErrorType, param: string | null = null) => ({
  error: { message: openAiApiMessages(getLocale(c))[code], type, param, code },
});
const errorResponse = (c: Context<AuthContext>, status: ErrorStatus, code: OpenAiErrorCode, type: ErrorType, param: string | null = null) =>
  c.json(errorBody(c, code, type, param), status);

// OpenAI clients often send `null` for fields they leave unset, so every optional field accepts it as absent.
const completionSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.string(),
        content: z.unknown(),
        tool_calls: z.array(z.unknown()).nullish(),
        function_call: z.unknown().nullish(),
      }),
    )
    .min(1),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  max_tokens: z.number().int().positive().nullish(),
  max_completion_tokens: z.number().int().positive().nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
  tools: z.array(z.unknown()).nullish(),
  functions: z.array(z.unknown()).nullish(),
  n: z.number().nullish(),
  response_format: z.object({ type: z.string() }).nullish(),
  audio: z.unknown().nullish(),
  modalities: z.array(z.string()).nullish(),
});
const textContent = z.union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))]);
const failedFinish = (reason: string | undefined) => reason === "error" || reason === "aborted" || reason === "interrupted";
const finishReason = (reason: string | undefined) => (reason === "max_tokens" ? "length" : "stop");
const usageBody = (usage: Usage) => ({
  prompt_tokens: usage.input,
  completion_tokens: usage.output,
  total_tokens: usage.input + usage.output,
});

type Dependencies = {
  limit?: MiddlewareHandler<AuthContext>;
  settings?: Pick<typeof coreSettings, "get">;
  authenticate?: typeof authenticateModelsOnlyCredential;
  listModels?: typeof listAssistantAiModels;
  resolveModel?: typeof resolveAiModel;
  acquire?: typeof acquire;
  inferenceProvider?: typeof inferenceProvider;
  keepaliveMs?: number;
};

export const createAiOpenAiRoutes = (dependencies: Dependencies = {}) => {
  const settings = dependencies.settings ?? coreSettings;
  const authenticate = dependencies.authenticate ?? authenticateModelsOnlyCredential;
  const listModels = dependencies.listModels ?? listAssistantAiModels;
  const resolveModel = dependencies.resolveModel ?? resolveAiModel;
  const acquireSlot = dependencies.acquire ?? acquire;
  const wrapProvider = dependencies.inferenceProvider ?? inferenceProvider;
  const limit = dependencies.limit ?? rateLimit();
  const app = new Hono<AuthContext>();
  app.onError((error, c) => {
    if (error instanceof AiQuotaError && error.code !== "quota_conflict")
      return errorResponse(c, 429, "insufficient_quota", "insufficient_quota");
    if (error instanceof Error && "aiError" in error) {
      const parsed = z.object({ code: z.string() }).safeParse(error.aiError);
      if (parsed.success) {
        if (parsed.data.code === "ai_disabled") return errorResponse(c, 403, "ai_disabled", "permission_error");
        if (parsed.data.code === "model_access_denied") return errorResponse(c, 403, "model_access_denied", "permission_error", "model");
        if (parsed.data.code === "model_policy_mismatch") return errorResponse(c, 404, "model_not_found", "invalid_request_error", "model");
        if (parsed.data.code === "missing_provider_credential") return errorResponse(c, 502, "missing_provider_credential", "api_error");
      }
    }
    return errorResponse(c, 500, "internal_error", "api_error");
  });
  return app
    .use("*", async (c, next) => {
      const response = await limit(c, next);
      if (response?.status === 429) return errorResponse(c, 429, "rate_limit_exceeded", "rate_limit_error");
      return response;
    })
    .use("*", async (c, next) => {
      if (!(await settings.get<boolean>("ai.openai_api_enabled"))) return errorResponse(c, 403, "openai_api_disabled", "permission_error");
      const token = c.req.header("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
      const credential = await authenticate(token);
      if (!credential) return errorResponse(c, 401, "invalid_api_key", "authentication_error");
      c.set("user", credential.user);
      c.set("accessSubject", { type: "user", userId: credential.user.id });
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/models",
      describeRoute({
        tags: ["AI"],
        summary: "List OpenAI-compatible models",
        description: "Models-only OpenAI-compatible surface: lists the Assistant chat models this person may use.",
      }),
      async (c) => {
        const models = await listModels(c.get("accessSubject"));
        return c.json({
          object: "list",
          data: models
            .filter((model) => !model.capabilities.includes("transcription"))
            .map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "cloud" })),
        });
      },
    )
    .post(
      "/chat/completions",
      describeRoute({
        tags: ["AI"],
        summary: "Create an OpenAI-compatible chat completion",
        description:
          "Models-only OpenAI-compatible text inference using only client messages, without Cloud tools or conversation context. Unknown fields are ignored.",
      }),
      async (c) => {
        const subject = c.get("accessSubject");
        const models = (await listModels(subject)).filter((model) => !model.capabilities.includes("transcription"));
        if (models.length === 0) return errorResponse(c, 404, "model_not_found", "invalid_request_error", "model");
        const slot = await acquireSlot({
          userId: c.get("user").id,
          limit: await settings.get<number>("ai.openai_api_max_concurrent_requests"),
        });
        if (!slot) {
          c.header("Retry-After", "1");
          return errorResponse(c, 429, "too_many_concurrent_requests", "rate_limit_error");
        }
        let ownsSlot = true;
        try {
          // estimateTokens assumes ~4 characters/token, each up to 4 UTF-8 bytes.
          // An unspecified context counts as Gemini's 1,000,000-token adapter default, the largest supported default.
          const maxSize = 16 * Math.max(0, ...models.map((model) => model.contextWindow ?? 1_000_000));
          let body: unknown;
          const tooLarge = await bodyLimit({
            maxSize,
            onError: () => errorResponse(c, 413, "request_too_large", "invalid_request_error"),
          })(c, async () => {
            body = await c.req.json().catch(() => undefined);
          });
          if (tooLarge) return tooLarge;
          const parsed = completionSchema.safeParse(body);
          if (!parsed.success)
            return errorResponse(c, 400, "invalid_request", "invalid_request_error", String(parsed.error.issues[0]?.path[0] ?? "") || null);
          const data = parsed.data;
          for (const [param, unsupported] of [
            ["tools", Boolean(data.tools?.length)],
            ["functions", Boolean(data.functions?.length)],
            ["n", data.n != null && data.n !== 1],
            ["response_format", data.response_format != null && data.response_format.type !== "text"],
            ["audio", data.audio != null],
            ["modalities", Boolean(data.modalities?.includes("audio"))],
          ] as const) {
            if (unsupported) return errorResponse(c, 400, "unsupported_parameter", "invalid_request_error", param);
          }
          const messages: Message[] = [];
          const system: string[] = [];
          for (const message of data.messages) {
            const content = textContent.safeParse(message.content);
            if (
              !content.success ||
              !["system", "developer", "user", "assistant"].includes(message.role) ||
              (message.role === "assistant" && (Boolean(message.tool_calls?.length) || message.function_call != null))
            )
              return errorResponse(c, 400, "unsupported_content", "invalid_request_error", "messages");
            const text = typeof content.data === "string" ? content.data : content.data.map((part) => part.text).join("");
            if (message.role === "system" || message.role === "developer") system.push(text);
            else if (message.role === "user") messages.push({ role: "user", content: [text] });
            else messages.push({ role: "assistant", content: [{ type: "text", text }] });
          }
          if (!models.some((model) => model.id === data.model))
            return errorResponse(c, 404, "model_not_found", "invalid_request_error", "model");
          const resolved = await resolveModel(personalAiModelPolicy, data.model);
          const systemPrompt = system.join("\n\n");
          const inputTokens = estimateTokens(messages) + Math.ceil(systemPrompt.length / 4);
          if (resolved.provider.contextWindow !== undefined && inputTokens > resolved.provider.contextWindow)
            return errorResponse(c, 400, "context_length_exceeded", "invalid_request_error", "messages");
          const requested = data.max_completion_tokens ?? data.max_tokens ?? undefined;
          const maxOutputTokens =
            requested === undefined
              ? resolved.profile.maxOutputTokens
              : resolved.profile.maxOutputTokens === undefined
                ? requested
                : Math.min(requested, resolved.profile.maxOutputTokens);
          const controller = new AbortController();
          const request: GenerateRequest = {
            messages,
            systemPrompt,
            temperature: data.temperature ?? undefined,
            maxOutputTokens,
            reasoningEffort: resolved.profile.reasoningEffort,
            signal: AbortSignal.any([c.req.raw.signal, controller.signal]),
            extraBody:
              data.top_p == null
                ? undefined
                : resolved.provider.family === "ollama"
                  ? { options: { top_p: data.top_p } }
                  : resolved.provider.family === "gemini"
                    ? { generationConfig: { topP: data.top_p } }
                    : { top_p: data.top_p },
          };
          const provider: Provider = wrapProvider(resolved.provider, resolved.profile, { kind: "chat", task: "openai-api", subject });
          const id = `chatcmpl-${crypto.randomUUID()}`;
          const created = Math.floor(Date.now() / 1000);
          let events: AsyncIterator<StreamEvent> | undefined;
          const kinds = new Map<string, string>();
          let usage: Usage | undefined;
          let reason: string | undefined;
          const readEvent = (event: StreamEvent): string | undefined => {
            if (event.type === "block_start") kinds.set(event.blockId, event.kind);
            if (event.type === "issue" && (event.issue.kind === "provider_error" || event.issue.kind === "timeout"))
              throw new Error("Upstream stream failed");
            if (event.type === "usage") {
              usage = event.usage;
              reason = event.finishReason;
              if (failedFinish(reason)) throw new Error("Upstream stream failed");
            }
            if (event.type === "block_delta" && kinds.get(event.blockId) === "text" && event.delta) return event.delta;
          };
          if (!data.stream) {
            try {
              request.signal?.throwIfAborted();
              setRequestTimeout(c, PROVIDER_WAIT_SECONDS);
              events = provider.stream(request)[Symbol.asyncIterator]();
              try {
                const text: string[] = [];
                for (;;) {
                  request.signal?.throwIfAborted();
                  const step = await events.next();
                  if (step.done) break;
                  setRequestTimeout(c, PROVIDER_WAIT_SECONDS);
                  const delta = readEvent(step.value);
                  if (delta !== undefined) text.push(delta);
                }
                return c.json({
                  id,
                  object: "chat.completion",
                  created,
                  model: resolved.profile.id,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: text.join("") },
                      logprobs: null,
                      finish_reason: finishReason(reason),
                    },
                  ],
                  ...(usage ? { usage: usageBody(usage) } : {}),
                });
              } finally {
                await events.return?.();
              }
            } catch (error) {
              if (error instanceof AiQuotaError) throw error;
              return errorResponse(c, 502, "upstream_error", "api_error");
            } finally {
              controller.abort();
            }
          }
          let first: string | undefined;
          let ended = false;
          try {
            request.signal?.throwIfAborted();
            setRequestTimeout(c, PROVIDER_WAIT_SECONDS);
            events = provider.stream(request)[Symbol.asyncIterator]();
            // Admission and failures before text still get an HTTP JSON error, before SSE commits headers.
            while (first === undefined) {
              const step = await events.next();
              if (step.done) {
                ended = true;
                break;
              }
              setRequestTimeout(c, PROVIDER_WAIT_SECONDS);
              first = readEvent(step.value);
            }
          } catch (error) {
            try {
              await events?.return?.();
            } finally {
              controller.abort();
            }
            if (error instanceof AiQuotaError) throw error;
            return errorResponse(c, 502, "upstream_error", "api_error");
          }
          const streamEvents = events;
          // From here the SSE callback releases the slot when the stream ends.
          ownsSlot = false;
          return streamSSE(c, async (stream) => {
            stream.onAbort(() => controller.abort());
            const chunk = (delta: { role?: string; content?: string }, finish: string | null = null) => ({
              id,
              object: "chat.completion.chunk",
              created,
              model: resolved.profile.id,
              choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
            });
            const send = (value: unknown) => stream.write(`data: ${JSON.stringify(value)}\n\n`);
            const keepalive = setInterval(() => {
              void stream.write(": keepalive\n\n").catch(() => undefined);
            }, dependencies.keepaliveMs ?? 5_000);
            try {
              await send(chunk({ role: "assistant", content: "" }));
              if (first !== undefined) await send(chunk({ content: first }));
              while (!ended) {
                request.signal?.throwIfAborted();
                const step = await streamEvents.next();
                if (step.done) break;
                const text = readEvent(step.value);
                if (text !== undefined) await send(chunk({ content: text }));
              }
              await send(chunk({}, finishReason(reason)));
              if (data.stream_options?.include_usage && usage)
                await send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: resolved.profile.id,
                  choices: [],
                  usage: usageBody(usage),
                });
              await stream.write("data: [DONE]\n\n");
            } catch {
              if (!request.signal?.aborted) await send(errorBody(c, "upstream_error", "api_error"));
            } finally {
              clearInterval(keepalive);
              try {
                await streamEvents.return?.();
              } finally {
                controller.abort();
                await slot.release();
              }
            }
          });
        } finally {
          setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
          if (ownsSlot) await slot.release();
        }
      },
    )
    .all("*", (c) => errorResponse(c, 404, "not_found", "invalid_request_error"));
};
