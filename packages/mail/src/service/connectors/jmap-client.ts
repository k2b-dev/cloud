import { z } from "zod";
import type { ProviderSecret } from "../../contracts";
import { type JmapResponse, type JmapTransportDependencies, requestJmap } from "./jmap-transport";

export const JMAP_CORE = "urn:ietf:params:jmap:core";
export const JMAP_MAIL = "urn:ietf:params:jmap:mail";
export const JMAP_SUBMISSION = "urn:ietf:params:jmap:submission";
// Default metadata budget, matching MAX_AUTOCONFIG_BYTES in onboarding-discovery.ts.
// Object-list callers supply a bounded budget derived from the requested properties and count.
export const JMAP_JSON_BYTES = 256 * 1024;
// Stalwart 1.0 sessions measured 1.5–4 KiB; 64 KiB allows 16 times that upper
// observation for capabilities/accounts, while bounding even the first unauthenticated response.
export const JMAP_SESSION_BYTES = 64 * 1024;

export class JmapError extends Error {
  constructor(
    readonly code:
      | "JMAP_INVALID_RESPONSE"
      | "JMAP_INVALID_ID"
      | "JMAP_ORIGIN"
      | "JMAP_REDIRECT"
      | "JMAP_CALL_LIMIT"
      | "JMAP_REQUEST_LIMIT"
      | "JMAP_CAPABILITY"
      | "JMAP_ACCOUNT"
      | "JMAP_FOLDER_TREE"
      | "JMAP_DISCOVERY_LIMIT"
      | "JMAP_EMAIL_TOO_LARGE",
  ) {
    super(code);
    this.name = "JmapError";
  }
}
export class JmapHttpError extends Error {
  readonly code = "JMAP_HTTP";
  constructor(readonly status: number) {
    super("JMAP HTTP request failed");
    this.name = "JmapHttpError";
  }
}
export class JmapRateLimitError extends Error {
  readonly code = "JMAP_RATE_LIMIT";
  constructor(readonly retryAfter: string | null) {
    super("JMAP request rate limited");
    this.name = "JmapRateLimitError";
  }
}
export class JmapRequestError extends Error {
  readonly code = "JMAP_REQUEST";
  constructor(readonly problemType: string) {
    super("JMAP request rejected");
    this.name = "JmapRequestError";
  }
}
export class JmapMethodError extends Error {
  readonly code = "JMAP_METHOD";
  constructor(readonly methodType: string) {
    super("JMAP method rejected");
    this.name = "JmapMethodError";
  }
}

export const jmapIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_-]+$/);
export function validateJmapId(value: unknown): string {
  const parsed = jmapIdSchema.safeParse(value);
  if (!parsed.success) throw new JmapError("JMAP_INVALID_ID");
  return parsed.data;
}
export const jmapCoreLimitsSchema = z.object({
  maxSizeUpload: z.number().int().positive(),
  maxConcurrentUpload: z.number().int().positive(),
  maxSizeRequest: z.number().int().positive(),
  maxConcurrentRequests: z.number().int().positive(),
  maxCallsInRequest: z.number().int().positive(),
  maxObjectsInGet: z.number().int().positive(),
  maxObjectsInSet: z.number().int().positive(),
  collationAlgorithms: z.array(z.string()),
});
const capabilityMap = z.record(z.string(), z.record(z.string(), z.unknown()));
const sessionSchema = z.object({
  capabilities: capabilityMap,
  accounts: z.record(
    jmapIdSchema,
    z.object({ name: z.string(), isPersonal: z.boolean(), isReadOnly: z.boolean(), accountCapabilities: capabilityMap }),
  ),
  primaryAccounts: z.record(z.string(), jmapIdSchema),
  username: z.string(),
  apiUrl: z.string(),
  downloadUrl: z.string(),
  uploadUrl: z.string(),
  eventSourceUrl: z.string(),
  state: z.string(),
});
export type JmapSession = z.infer<typeof sessionSchema> & { origin: string; core: z.infer<typeof jmapCoreLimitsSchema> };
export type JmapAccess = { origin: string; authorization: string; signal: AbortSignal };
export type JmapInvocation = [string, Record<string, unknown>, string];
const invocationSchema = z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]);
const responseSchema = z.object({ methodResponses: z.array(invocationSchema), sessionState: z.string() });
const redirects = new Set([301, 302, 307, 308]);

function httpsUrl(value: string, origin?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new JmapError("JMAP_ORIGIN");
  }
  if (url.protocol !== "https:" || url.username || url.password || (origin && url.origin !== origin)) throw new JmapError("JMAP_ORIGIN");
  return url;
}
function redirectUrl(response: JmapResponse, from: URL): URL {
  if (!response.location) throw new JmapError("JMAP_REDIRECT");
  try {
    return httpsUrl(new URL(response.location, from).href, from.origin);
  } catch {
    throw new JmapError("JMAP_REDIRECT");
  }
}
function json(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new JmapError("JMAP_INVALID_RESPONSE");
  }
}
function checkHttp(response: JmapResponse): void {
  if (response.status === 429) {
    // Retain Retry-After syntax only, never arbitrary reflected response text.
    const value = response.retryAfter;
    const retryAfter =
      value && (/^\d+$/.test(value) || /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value))
        ? value
        : null;
    throw new JmapRateLimitError(retryAfter);
  }
  if (response.status >= 200 && response.status < 300) return;
  let problem: unknown;
  try {
    problem = JSON.parse(response.body);
  } catch {
    /* HTTP failures need not be JSON. */
  }
  const parsed = z.object({ type: z.string() }).safeParse(problem);
  if (parsed.success) {
    const known = [
      "about:blank",
      "urn:ietf:params:jmap:error:unknownCapability",
      "urn:ietf:params:jmap:error:notJSON",
      "urn:ietf:params:jmap:error:notRequest",
      "urn:ietf:params:jmap:error:limit",
    ];
    throw new JmapRequestError(known.includes(parsed.data.type) ? parsed.data.type : "unknown");
  }
  throw new JmapHttpError(response.status);
}

/** Credential-free hint only: this never authorizes use of the discovered origin. */
export type JmapDetection = "detected" | "absent" | "unknown";
export async function probeJmap(host: string, signal: AbortSignal, deps: JmapTransportDependencies = {}): Promise<JmapDetection> {
  try {
    if (!host || /[\s/@\\?#]/.test(host) || (host.includes(":") && !(host.startsWith("[") && host.endsWith("]")))) return "unknown";
    let url = httpsUrl(`https://${host}/.well-known/jmap`);
    if (url.port) return "unknown";
    const get = () => requestJmap({ url, method: "GET", maxBytes: JMAP_SESSION_BYTES, signal }, deps);
    let response = await get();
    if (redirects.has(response.status)) {
      try {
        url = redirectUrl(response, url);
      } catch {
        return "absent";
      }
      response = await get();
    }
    if (response.status === 401) return "detected";
    if (response.status !== 200) return "absent";
    try {
      const parsed = z.object({ capabilities: z.record(z.string(), z.unknown()) }).safeParse(json(response.body));
      return parsed.success && Object.hasOwn(parsed.data.capabilities, JMAP_CORE) ? "detected" : "absent";
    } catch {
      return "absent";
    }
  } catch {
    return "unknown";
  }
}

export function jmapBasicAuthorization(username: string, secret: ProviderSecret): string {
  if (username.includes(":") || /[\r\n]/.test(username)) throw new JmapError("JMAP_ACCOUNT");
  return `Basic ${Buffer.from(`${username}:${secret.password}`, "utf8").toString("base64")}`;
}

export async function fetchJmapSession(input: JmapAccess, deps: JmapTransportDependencies = {}): Promise<JmapSession> {
  const origin = httpsUrl(input.origin).origin;
  let url = new URL("/.well-known/jmap", origin);
  const get = () =>
    requestJmap({ url, method: "GET", authorization: input.authorization, signal: input.signal, maxBytes: JMAP_SESSION_BYTES }, deps);
  let response = await get();
  if (redirects.has(response.status)) {
    url = redirectUrl(response, url);
    response = await get();
  }
  if (response.status >= 300 && response.status < 400) throw new JmapError("JMAP_REDIRECT");
  checkHttp(response);
  const parsed = sessionSchema.safeParse(json(response.body));
  if (!parsed.success) throw new JmapError("JMAP_INVALID_RESPONSE");
  const session = parsed.data;
  for (const key of ["apiUrl", "downloadUrl", "uploadUrl", "eventSourceUrl"] as const) {
    const template = session[key];
    let resolved: URL;
    try {
      resolved = new URL(template, url);
    } catch {
      throw new JmapError("JMAP_ORIGIN");
    }
    let normalized = httpsUrl(resolved.href, origin).href;
    // WHATWG URL encodes braces in path segments; keep JMAP URI-template variables intact.
    for (const [placeholder] of template.matchAll(/\{[A-Za-z][A-Za-z0-9]*\}/g)) {
      normalized = normalized.replaceAll(encodeURIComponent(placeholder), placeholder);
    }
    session[key] = normalized;
  }
  const core = jmapCoreLimitsSchema.safeParse(session.capabilities[JMAP_CORE]);
  if (!core.success) throw new JmapError("JMAP_INVALID_RESPONSE");
  return { ...session, origin, core: core.data };
}

export async function callJmap(
  input: {
    session: JmapSession;
    authorization: string;
    using: string[];
    methodCalls: JmapInvocation[];
    signal: AbortSignal;
    maxBytes?: number;
  },
  deps: JmapTransportDependencies = {},
) {
  if (input.methodCalls.length > input.session.core.maxCallsInRequest) throw new JmapError("JMAP_CALL_LIMIT");
  const calls = new Map(input.methodCalls.map(([name, , id]) => [id, name]));
  if (calls.size !== input.methodCalls.length) throw new JmapError("JMAP_INVALID_RESPONSE");
  const url = httpsUrl(input.session.apiUrl, input.session.origin);
  const body = JSON.stringify({ using: input.using, methodCalls: input.methodCalls });
  if (Buffer.byteLength(body) > input.session.core.maxSizeRequest) throw new JmapError("JMAP_REQUEST_LIMIT");
  const response = await requestJmap(
    { url, method: "POST", authorization: input.authorization, body, maxBytes: input.maxBytes ?? JMAP_JSON_BYTES, signal: input.signal },
    deps,
  );
  if (response.status >= 300 && response.status < 400) throw new JmapError("JMAP_REDIRECT");
  checkHttp(response);
  const parsed = responseSchema.safeParse(json(response.body));
  if (!parsed.success) throw new JmapError("JMAP_INVALID_RESPONSE");
  // One response per call holds for the read methods used today. A method with implicit follow-up
  // calls (EmailSubmission/set with onSuccessUpdateEmail, Foo/copy with onSuccessDestroyOriginal)
  // answers twice under one call id (RFC 8620 §5.4); sending must relax this check.
  if (parsed.data.methodResponses.length !== calls.size) throw new JmapError("JMAP_INVALID_RESPONSE");
  for (const [name, args, id] of parsed.data.methodResponses) {
    const expected = calls.get(id);
    if (!expected || (name !== expected && name !== "error")) throw new JmapError("JMAP_INVALID_RESPONSE");
    calls.delete(id);
    if (name === "error" && typeof args.type !== "string") throw new JmapError("JMAP_INVALID_RESPONSE");
  }
  return parsed.data;
}

/** Require one correlated success; callers that need independent failures inspect the tuples. */
export function requireJmapMethodResult(response: z.infer<typeof responseSchema>, callId: string, name: string): Record<string, unknown> {
  const results = response.methodResponses.filter(([, , id]) => id === callId);
  const result = results[0];
  if (results.length !== 1 || !result) throw new JmapError("JMAP_INVALID_RESPONSE");
  if (result[0] === "error") {
    const args = result[1];
    const known = [
      "serverUnavailable",
      "serverFail",
      "serverPartialFail",
      "unknownMethod",
      "invalidArguments",
      "invalidResultReference",
      "forbidden",
      "accountNotFound",
      "accountNotSupportedByMethod",
      "accountReadOnly",
      "requestTooLarge",
      "cannotCalculateChanges",
      "stateMismatch",
      "unsupportedFilter",
      "unsupportedSort",
      "anchorNotFound",
    ];
    throw new JmapMethodError(typeof args.type === "string" && known.includes(args.type) ? args.type : "unknown");
  }
  if (result[0] !== name) throw new JmapError("JMAP_INVALID_RESPONSE");
  return result[1];
}
