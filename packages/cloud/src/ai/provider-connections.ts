import { sql } from "bun";
import { z } from "zod";
import { logger } from "../services/logging";
import { getAiCredential } from "./credentials";
import type { AiProvider } from "./model-contracts";
import { getAiRequestHeaders } from "./request-headers";

export type AiProviderTestResult = {
  status: "ok" | "unreachable" | "key_rejected" | "error";
  httpStatus?: number;
  message: string;
  latencyMs?: number;
};
export type AiAvailableProviderModel = { providerModel: string; label?: string; kind?: "chat" | "transcription"; contextWindow?: number };
type Connection = Pick<AiProvider, "type" | "baseUrl"> & { apiKey?: string; headers?: Record<string, string> };
const defaults = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  ollama: "http://localhost:11434",
  vllm: "http://localhost:8000/v1",
  "openai-compatible": "",
};
export class AiProviderListError extends Error {
  constructor(
    readonly code: "unreachable" | "key_rejected" | "list_failed",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
export const classifyProviderFailure = (error: unknown): AiProviderTestResult => {
  const details = z
    .object({ status: z.number().optional(), statusCode: z.number().optional(), code: z.string().optional(), name: z.string().optional() })
    .passthrough()
    .safeParse(error);
  const httpStatus =
    error instanceof AiProviderListError
      ? error.httpStatus
      : details.success
        ? (details.data.status ?? details.data.statusCode)
        : undefined;
  const status =
    httpStatus === 401 || httpStatus === 403
      ? "key_rejected"
      : (error instanceof AiProviderListError && error.code === "unreachable") ||
          error instanceof TypeError ||
          (details.success && ["TimeoutError", "AbortError"].includes(details.data.name ?? "")) ||
          (details.success && ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(details.data.code ?? ""))
        ? "unreachable"
        : "error";
  return {
    status,
    ...(httpStatus ? { httpStatus } : {}),
    message:
      status === "key_rejected"
        ? "The provider rejected the credential."
        : status === "unreachable"
          ? "The provider did not respond within 10 seconds or could not be reached."
          : "The provider request failed.",
  };
};
export const recordAiProviderStatus = async (id: string, result: AiProviderTestResult, force = false) => {
  try {
    await sql`UPDATE ai.providers SET status=${result.status},status_code=${result.httpStatus?.toString() ?? null},status_message=${result.message},status_checked_at=clock_timestamp() WHERE id=${id} AND (${force} OR status IS DISTINCT FROM ${result.status} OR status_code IS DISTINCT FROM ${result.httpStatus?.toString() ?? null})`;
  } catch {
    logger("ai:providers").warn("Could not persist provider connection status", { providerId: id });
  }
};
const requestModels = async (provider: Connection, signal?: AbortSignal, after?: string) => {
  const base = (provider.baseUrl ?? defaults[provider.type]).replace(/\/$/, "");
  if (!base) throw new AiProviderListError("list_failed", "The provider has no base URL.");
  const headers = new Headers(provider.headers);
  if (provider.type === "anthropic") {
    headers.set("anthropic-version", "2023-06-01");
    if (provider.apiKey) headers.set("x-api-key", provider.apiKey);
  } else if (provider.apiKey) headers.set("authorization", `Bearer ${provider.apiKey}`);
  let response: Response;
  try {
    response = await fetch(
      `${base}${provider.type === "ollama" ? "/api/tags" : `/models${after ? `?after_id=${encodeURIComponent(after)}` : ""}`}`,
      { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000), redirect: "error" },
    );
  } catch {
    throw new AiProviderListError("unreachable", "The provider could not be reached.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new AiProviderListError(
      response.status === 401 || response.status === 403 ? "key_rejected" : "list_failed",
      "The provider could not list models.",
      response.status,
    );
  }
  return response;
};
/** Cloud's one listing seam; move it to nessi listModels() when that API ships. */
export const listProviderModels = async (provider: Connection, signal?: AbortSignal): Promise<AiAvailableProviderModel[]> => {
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const models: AiAvailableProviderModel[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  do {
    const response = await requestModels(provider, deadline, after);
    try {
      const body: unknown = await response.json();
      if (provider.type === "ollama")
        return z
          .object({ models: z.array(z.object({ name: z.string() })) })
          .parse(body)
          .models.map((model) => ({ providerModel: model.name }));
      const page = z
        .object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string().optional(),
              display_name: z.string().optional(),
              context_length: z.number().int().positive().optional(),
            }),
          ),
          has_more: z.boolean().optional(),
          last_id: z.string().optional(),
        })
        .parse(body);
      models.push(
        ...page.data.map((model) => ({
          providerModel: model.id,
          ...((model.display_name ?? model.name) ? { label: model.display_name ?? model.name } : {}),
          ...(model.context_length ? { contextWindow: model.context_length } : {}),
        })),
      );
      if (provider.type !== "anthropic" || !page.has_more) return models;
      after = page.last_id ?? page.data.at(-1)?.id;
      if (!after || seen.has(after)) throw new Error("Non-advancing model cursor");
      seen.add(after);
    } catch {
      throw new AiProviderListError("list_failed", "The provider returned an invalid model list.");
    }
  } while (!deadline.aborted);
  throw new AiProviderListError("unreachable", "The provider model list timed out.");
};
export const storedProviderConnection = async (provider: AiProvider): Promise<Connection> => ({
  ...provider,
  apiKey: (await getAiCredential(provider.id)) ?? undefined,
  headers: await getAiRequestHeaders(provider.id),
});
export const testAiProvider = async (provider: Connection, signal?: AbortSignal): Promise<AiProviderTestResult> => {
  const start = Date.now();
  try {
    const response = await requestModels(provider, signal);
    await response.body?.cancel();
    return { status: "ok", httpStatus: response.status, message: "The provider connection works.", latencyMs: Date.now() - start };
  } catch (error) {
    return { ...classifyProviderFailure(error), latencyMs: Date.now() - start };
  }
};
