import { z } from "zod";

/** Names are identifiers, never secret values. SDK secrets.NAME produces [secret:NAME]. */
export const CodeSecretNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .describe("Credential identifier, also used by SDK secrets.NAME.");
/** Routing, hop-by-hop and browser session headers cannot carry Code credentials. */
export const codeSecretHeaderAllowed = (name: string): boolean =>
  /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) &&
  !/^(host|cookie|set-cookie|connection|content-length|transfer-encoding|te|trailer|upgrade|expect|accept-encoding|proxy-.*|forwarded|x-forwarded-.*|x-cloud-.*)$/.test(
    name,
  );
/** Refuse ambiguous paths before WHATWG URL parsing can normalize away traversal. Percent escapes are deliberately excluded. */
export const codeSecretPathAllowed = (path: string): boolean =>
  path.startsWith("/") && !/[\\%?#\s\u0000-\u001f\u007f]/.test(path) && path.split("/").every((part) => part !== "." && part !== "..");
/** Exact HTTPS origin (including effective port), path at a segment boundary, and permitted header names. */
export const CodeSecretBindingSchema = z
  .object({
    origin: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === "https:" && url.origin === value && !url.username && !url.password && !url.hostname.endsWith(".");
        } catch {
          return false;
        }
      }, "Use an exact HTTPS origin without credentials, path or final DNS dot.")
      .describe("Exact HTTPS origin, including non-default port, without a path or trailing slash."),
    pathPrefix: z
      .string()
      .refine(codeSecretPathAllowed, "Use an unencoded absolute path without traversal.")
      .describe("Permitted absolute path prefix, matched at a segment boundary."),
    headers: z
      .array(z.string().refine(codeSecretHeaderAllowed, "Use a permitted lowercase credential header."))
      .min(1)
      .refine((names) => new Set(names).size === names.length, "Header names must be unique.")
      .describe("Lowercase header names permitted to receive this credential."),
  })
  .strict();
export type CodeSecretBinding = z.infer<typeof CodeSecretBindingSchema>;
/** Immutable public binding evidence. Values live separately and never enter a manifest or runner. */
export const CodeSecretVersionBindingSchema = CodeSecretBindingSchema.extend({
  name: CodeSecretNameSchema,
  binding_revision: z.uuid().describe("Immutable binding revision approved with this version; value changes do not change it."),
}).strict();
export type CodeSecretVersionBinding = z.infer<typeof CodeSecretVersionBindingSchema>;
/** No secret material: this is the complete header placeholder visible to Code, tests and call observations. */
export const codeSecretPlaceholder = (name: string): string => `[secret:${CodeSecretNameSchema.parse(name)}]`;
/** JSON transport for http.fetch. Body is UTF-8 text; response bytes use base64. Administrative payload budgets apply. */
export const CodeHttpRequestSchema = z
  .object({
    url: z.string().min(1),
    method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).default("GET"),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().optional(),
  })
  .strict();
export type CodeHttpRequest = z.infer<typeof CodeHttpRequestSchema>;
export const CodeHttpResultSchema = z
  .object({
    status: z.number().int(),
    headers: z.record(z.string(), z.string()),
    body: z.string(),
  })
  .strict();
export type CodeHttpResult = z.infer<typeof CodeHttpResultSchema>;
