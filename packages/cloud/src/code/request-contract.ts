import { z } from "zod";

/** Interactive requests share runner slots and the Code's call budgets. Their deadline includes queueing.
 * Input stays inside the existing 32-KiB run envelope; output inside the 256-KiB run output envelope. */
export const CODE_REQUEST_LIMITS = Object.freeze({
  timeoutMs: 8_000,
  bodyBytes: 8 * 1024,
  publicBodyBytes: 4 * 1024,
  responseBytes: 128 * 1024,
  urlBytes: 2048,
  publicPerMinute: 20,
});
export const CodeRouteRequestSchema = z
  .object({
    method: z.enum(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]),
    path: z.string().max(CODE_REQUEST_LIMITS.urlBytes),
    query: z.string().max(CODE_REQUEST_LIMITS.urlBytes),
    contentType: z.enum(["application/json", "text/plain", "application/x-www-form-urlencoded"]),
    body: z.string().max(CODE_REQUEST_LIMITS.bodyBytes),
    params: z.record(z.string(), z.string()),
    user: z
      .object({ id: z.string(), groups: z.array(z.string()) })
      .strict()
      .nullable(),
    codeId: z.string(),
  })
  .strict();
export type CodeRouteRequest = z.infer<typeof CodeRouteRequestSchema>;
/** Headers are chosen by Core. Code can return data or an own-path redirect, never HTML, cookies or arbitrary headers. */
export const CodeRouteResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["json", "text"]), status: z.number().int().min(200).max(599), body: z.string() }).strict(),
  z
    .object({
      kind: z.literal("redirect"),
      status: z.union([z.literal(302), z.literal(303), z.literal(307), z.literal(308)]),
      location: z.string().max(2048),
    })
    .strict(),
]);
export type CodeRouteResponse = z.infer<typeof CodeRouteResponseSchema>;
