import { z } from "zod";

/** Private Assistant/runner protocol. Authority stays in the turn host, never in this payload. */
export const ChatRunInputSchema = z
  .object({
    bundle: z.string().min(1),
    modules: z.record(z.enum(["csv.js", "sheet.js", "finance.js", "pdf-read.js"]), z.string()),
    context: z.object({ locale: z.string(), timeZone: z.string(), user: z.object({ id: z.string(), name: z.string() }).nullable() }),
    files: z.array(z.object({ path: z.string(), size: z.number().nonnegative(), type: z.string() })).max(64),
  })
  .strict();
export type ChatRunInput = z.infer<typeof ChatRunInputSchema>;
export const ChatRunReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ message: z.string().max(16000), code: z.string().optional() }).strict() }).strict(),
]);
export type ChatRunReply = z.infer<typeof ChatRunReplySchema>;
export const ChatRunPollSchema = z.object({
  state: z.string(),
  result: z.unknown(),
  calls: z.array(z.object({ id: z.uuid(), operation: z.string(), input: z.json() })),
});

/** Explicit tagged values retain files and typed bytes across the runner's JSON-only bridge.
 * Every value is tagged, so user objects cannot masquerade as file metadata. */
export async function encodeChatValue(value: unknown): Promise<z.infer<ReturnType<typeof z.json>>> {
  if (value === undefined) return ["undefined"];
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return ["blob", btoa(binary), value.type, value instanceof File ? value.name : null];
  }
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    const blob = await encodeChatValue(new Blob([value instanceof Uint8Array ? new Uint8Array(value) : value]));
    return [value instanceof ArrayBuffer ? "buffer" : "bytes", blob];
  }
  if (Array.isArray(value)) return ["array", await Promise.all(value.map(encodeChatValue))];
  if (value !== null && typeof value === "object")
    return ["object", await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeChatValue(item)]))];
  return ["json", z.json().parse(value)];
}
export function decodeChatValue(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("code_chat_invalid_value");
  const [kind, data, type, name] = value;
  if (kind === "undefined") return undefined;
  if (kind === "json") return z.json().parse(data);
  if (kind === "blob" && typeof data === "string" && typeof type === "string") {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return typeof name === "string" ? new File([bytes], name, { type }) : new Blob([bytes], { type });
  }
  if (kind === "array" && Array.isArray(data)) return data.map(decodeChatValue);
  if (kind === "object" && Array.isArray(data))
    return Object.fromEntries(
      data.map((entry) => {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") throw new Error("code_chat_invalid_value");
        return [entry[0], decodeChatValue(entry[1])];
      }),
    );
  if ((kind === "buffer" || kind === "bytes") && Array.isArray(data) && data[0] === "blob" && typeof data[1] === "string") {
    const bytes = Uint8Array.from(atob(data[1]), (c) => c.charCodeAt(0));
    return kind === "buffer" ? bytes.buffer : bytes;
  }
  throw new Error("code_chat_invalid_value");
}
