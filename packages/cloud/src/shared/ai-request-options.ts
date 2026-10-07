import { z } from "zod";

// nessi 0.15 deep-merges extraBody last. Reserve identity/content, tool/loop
// control, structured output, and profile-owned generation settings across all
// adapters so an escape hatch cannot replace Cloud's request or quota budget.
export const AI_RESERVED_EXTRA_BODY_KEYS = [
  "model",
  "models",
  "route",
  "messages",
  "system",
  "contents",
  "systemInstruction",
  "tools",
  "tool_choice",
  "toolConfig",
  "parallel_tool_calls",
  "stream",
  "stream_options",
  "response_format",
  "structured_outputs",
  "format",
  "temperature",
  "n",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "reasoning",
] as const;
const keyName = (key: string) => key.replace(/_/g, "").toLowerCase();
const reserved = new Set(AI_RESERVED_EXTRA_BODY_KEYS.map(keyName));
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const nestedReserved = new Map<string, ReadonlySet<string>>([
  [
    keyName("generationConfig"),
    new Set(["responseSchema", "responseJsonSchema", "responseMimeType", "temperature", "maxOutputTokens", "candidateCount"].map(keyName)),
  ],
  [keyName("output_config"), new Set(["format"].map(keyName))],
  [keyName("options"), new Set(["temperature", "num_predict"].map(keyName))],
]);
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const AiReasoningEffortSchema = z.preprocess(
  (value) => (typeof value === "string" && !value.trim() ? undefined : value),
  z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
);

export const AiExtraBodySchema = z
  .custom<Record<string, unknown>>(plainObject, "Extra parameters must be a plain JSON object.")
  .superRefine((body, ctx) => {
    if (!plainObject(body)) return;
    try {
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 8192) {
        ctx.addIssue({ code: "custom", message: "Extra parameters exceed 8 KiB of UTF-8 JSON." });
        return;
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "Extra parameters must contain serializable JSON values." });
      return;
    }
    let invalidJson = false;
    const seen = new Set<object>();
    const pending: { value: unknown; path: (string | number)[] }[] = [{ value: body, path: [] }];
    while (pending.length) {
      const entry = pending.pop()!;
      const { value, path } = entry;
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      )
        continue;
      if (!Array.isArray(value) && !plainObject(value)) {
        invalidJson = true;
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (unsafeKeys.has(key))
          ctx.addIssue({ code: "custom", path: [...path, key], message: "Prototype keys are not allowed in extra parameters." });
        pending.push({ value: child, path: [...path, key] });
      }
    }
    if (invalidJson) {
      ctx.addIssue({ code: "custom", message: "Extra parameters must contain only JSON values." });
      return;
    }
    for (const key of Object.keys(body)) {
      const normalizedKey = keyName(key);
      if (reserved.has(normalizedKey))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            normalizedKey === "reasoning" || normalizedKey === "reasoningeffort"
              ? "Use the thinking-level field (reasoningEffort) instead."
              : "This parameter is owned by Cloud; use the model profile fields instead.",
        });
      const nested = body[key];
      const reservedChildren = nestedReserved.get(normalizedKey);
      if (reservedChildren && !plainObject(nested))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "This parameter must be a plain JSON object so Cloud can preserve its owned settings.",
        });
      if (plainObject(nested))
        for (const child of Object.keys(nested)) {
          if (reservedChildren?.has(keyName(child)))
            ctx.addIssue({
              code: "custom",
              path: [key, child],
              message: "This parameter is owned by Cloud's generation or structured-output settings.",
            });
        }
    }
  })
  .meta({
    type: "object",
    additionalProperties: true,
    description: "Extra provider parameters (at most 8192 bytes of UTF-8 JSON); Cloud-owned request keys are reserved.",
  });

const reservedHeaders = new Set(["content-type", "content-length", "host", "connection", "transfer-encoding"]);
// Validate with metadata-only messages: never include a submitted header value.
export const AiRequestHeadersSchema = z
  .custom<Record<string, string | null>>(plainObject, "Extra headers must be a JSON object of names to strings or null.")
  .superRefine((headers, ctx) => {
    if (!plainObject(headers)) return;
    if (Object.keys(headers).length > 32) ctx.addIssue({ code: "custom", message: "At most 32 extra headers are allowed." });
    const names = new Set<string>();
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
        ctx.addIssue({ code: "custom", path: [name], message: "Header names must be HTTP tokens of at most 128 characters." });
      if (names.has(lower)) ctx.addIssue({ code: "custom", path: [name], message: "Duplicate header names are case-insensitive." });
      names.add(lower);
      if (reservedHeaders.has(lower)) ctx.addIssue({ code: "custom", path: [name], message: "This HTTP header is reserved." });
      if (value !== null && (typeof value !== "string" || value.length > 4096 || /[^\t\x20-\x7E]/.test(value)))
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Header values must be strings of at most 4096 printable ASCII characters, spaces or tabs, or null to remove.",
        });
    }
  })
  .meta({
    type: "object",
    maxProperties: 32,
    propertyNames: { type: "string", maxLength: 128, pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" },
    additionalProperties: { anyOf: [{ type: "string", maxLength: 4096, pattern: "^[\\t\\x20-\\x7E]*$" }, { type: "null" }] },
    writeOnly: true,
  });

export const AI_REQUEST_HEADERS_PROVIDER_ERROR = "Extra headers are only supported for vLLM and OpenAI-compatible endpoints.";
export const providerSupportsRequestHeaders = (provider: string): boolean => provider === "vllm" || provider === "openai-compatible";

/** Case-insensitive PATCH. Canonical Authorization avoids duplicate casing in nessi's Bearer overwrite. */
export const patchAiRequestHeaders = (current: Record<string, string>, patch: Record<string, string | null>): Record<string, string> => {
  AiRequestHeadersSchema.parse(patch);
  const result: Record<string, string> = Object.fromEntries(Object.entries(current));
  for (const [name, value] of Object.entries(patch)) {
    for (const stored of Object.keys(result)) if (stored.toLowerCase() === name.toLowerCase()) delete result[stored];
    if (value !== null)
      Object.defineProperty(result, name.toLowerCase() === "authorization" ? "Authorization" : name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  AiRequestHeadersSchema.parse(result);
  return result;
};
