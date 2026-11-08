import { z } from "zod";
import { LIMITS } from "./contracts";

// Base64 and JSON envelopes must fit the existing worker RPC budget.
export const HTTP_BYTES = LIMITS.rpcBytes / 4;
export const HTTP_TIMEOUT_MS = 20000;
export const HTTP_CALL_TTL_MS = 24 * 60 * 60 * 1000;
export const SecretName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const HeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]+$/i)
  .max(80)
  .transform((v) => v.toLowerCase())
  .refine(
    (v) =>
      ![
        "host",
        "cookie",
        "set-cookie",
        "connection",
        "content-length",
        "transfer-encoding",
        "upgrade",
        "trailer",
        "te",
        "expect",
        "accept-encoding",
      ].includes(v) &&
      !v.startsWith("proxy-") &&
      !v.startsWith("sec-"),
    "This header is controlled by the HTTP service",
  );
export const HeaderValue = z
  .string()
  .max(LIMITS.text)
  .regex(/^[\x20-\x7e\x80-\xff]*$/);
export const SecretReference = z.object({ secret: SecretName, prefix: HeaderValue.default("") }).strict();
export type SecretReference = z.infer<typeof SecretReference>;
export const HttpScope = z
  .object({
    resourceId: z
      .string()
      .regex(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{6}$/)
      .optional(),
    conversationId: z.string().min(1).max(80).optional(),
  })
  .strict()
  .refine((v) => v.resourceId || v.conversationId, "A resource or conversation is required");
export type HttpScope = z.infer<typeof HttpScope>;
export const HttpsUrl = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }, "Use an HTTPS URL without credentials or fragment");
export const SecretMetadata = z.object({
  name: SecretName,
  origin: HttpsUrl.transform((value) => new URL(value).origin),
  header: HeaderName,
  prefix: HeaderValue.default(""),
});
export const SecretSave = SecretMetadata.extend({ value: HeaderValue.min(1), expectedRevision: z.uuid().nullable() });
export type SecretMetadata = z.infer<typeof SecretMetadata>;
export const SecretView = SecretMetadata.extend({ revision: z.uuid(), configured: z.literal(true) });
export const HttpRequest = z
  .object({
    url: HttpsUrl,
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
    headers: z
      .record(z.string(), z.union([HeaderValue, SecretReference]))
      .superRefine((headers, ctx) => {
        const keys = Object.keys(headers).map((key) => key.toLowerCase());
        for (const key of Object.keys(headers))
          if (!HeaderName.safeParse(key).success) ctx.addIssue({ code: "custom", message: "Invalid or controlled HTTP header" });
        if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate header names" });
      })
      .transform((headers) => Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])))
      .default({}),
    body: z
      .string()
      .max(Math.ceil(HTTP_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((value) => value.length % 4 === 0, "Invalid base64 length")
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (Object.keys(v.headers).length > 64) c.addIssue({ code: "custom", message: "Too many headers" });
    if ((v.method === "GET" || v.method === "HEAD") && v.body !== undefined)
      c.addIssue({ code: "custom", message: "GET and HEAD cannot have a body" });
    if (JSON.stringify(v.headers).length > LIMITS.text) c.addIssue({ code: "custom", message: "Headers exceed budget" });
  });
export type HttpRequest = z.infer<typeof HttpRequest>;
/**
 * Request headers a website read may carry: those that only describe the response the code wants or the client it is,
 * never who asks or what to do. None of them carries a credential, overrides the method, or changes routing, and the
 * HTTP service forwards no cookie or Cloud authentication, so the request stays an anonymous read of the same origin.
 * `HeaderName` already rejects `cookie`, `proxy-*`, and the other headers the HTTP service controls; `authorization`,
 * API keys, method overrides, and every other header ask every time.
 */
export const WEBSITE_READ_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "range",
  "user-agent",
  "if-none-match",
  "if-modified-since",
]);
/**
 * Each value of such a header holds at most this many characters, the Fetch standard's limit for a CORS-safelisted
 * request header value. The receipt of a request a website approval lets through shows only its method and URL, so this
 * keeps what the code can add beside the URL small. A longer value makes the request ask.
 */
export const WEBSITE_READ_HEADER_LENGTH = 128;

/**
 * Whether a request only reads its website: GET or HEAD, which never has a body, and every header plain, listed in
 * `WEBSITE_READ_HEADERS`, and short. The approval card and dialog say "reads" only for such a request, and only such a
 * request can be covered by a website approval; the server additionally refuses a header one of the person's secrets
 * is bound to.
 */
export function isWebsiteRead(request: { method: string; headers: Record<string, string | SecretReference> }): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    Object.entries(request.headers).every(
      ([name, value]) => typeof value === "string" && WEBSITE_READ_HEADERS.has(name) && value.length <= WEBSITE_READ_HEADER_LENGTH,
    )
  );
}
export const HttpPrepare = z.object({ id: z.uuid(), createdAt: z.number().int(), scope: HttpScope, request: HttpRequest }).strict();
export type HttpPrepare = z.infer<typeof HttpPrepare>;
export const HttpReview = z.object({
  id: z.uuid(),
  url: z.string(),
  method: z.string(),
  bodyBytes: z.number(),
  headers: z.record(z.string(), z.union([z.string(), SecretReference])),
  bodyPreview: z.string(),
  bodyTruncated: z.boolean(),
  resourceTitle: z.string().optional(),
});
export type HttpReview = z.infer<typeof HttpReview>;
export const HttpResult = z.object({
  status: z.number().int().min(200).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string().max(Math.ceil(HTTP_BYTES / 3) * 4),
});
