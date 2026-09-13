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
  .object({ resourceId: z.uuid().optional(), conversationId: z.string().min(1).max(80).optional() })
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
