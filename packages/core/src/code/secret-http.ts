import { sql } from "@k2b/cloud";
import { type CodeBridgeAuthority, CodeBridgeRefusal, codeHttpOriginAllowed } from "@k2b/cloud/api";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CodeHttpRequest,
  CodeHttpRequestSchema,
  CodeInternetOriginSchema,
  CodeInternetOriginsSchema,
  type CodeSecretVersionBinding,
  CodeSecretVersionBindingSchema,
  codeSecretHeaderAllowed,
  codeSecretPathAllowed,
} from "@k2b/cloud/contracts";
import { purposeSecretCipher, requestPublicHttps } from "@k2b/cloud/services";
import { withNetworkDeadline } from "@k2b/cloud/services/network-transport";
import { z } from "zod";
import { CODE_SECRET_PURPOSE, codeSecretContext, validateCodeSecretBindings } from "./secrets";
import { codeSettings } from "./settings";

// Fetch's HTTP-redirect fetch algorithm permits at most 20 redirects per request.
const MAX_REDIRECTS = 20;
const deny = (code = "code_http_secret_forbidden"): never => {
  throw new CodeBridgeRefusal(code);
};
/** Check raw spelling before URL normalization removes traversal. Percent-encoded path components are deliberately unsupported. */
export function codeSecretRequestUrl(raw: string, ownOrigins: readonly string[]): URL {
  if (/[\\\s\u0000-\u001f\u007f]/.test(raw) || raw.includes("[secret:") || !codeHttpOriginAllowed(raw, ownOrigins))
    return deny("code_http_origin_forbidden");
  const spelling = /^https:\/\/[^/?#]+(\/[^?#]*)?(?:\?[^#]*)?$/i.exec(raw);
  if (!spelling) return deny("code_http_path_forbidden");
  const path = spelling[1] ?? "/";
  const url = new URL(raw);
  if (url.hash || !codeSecretPathAllowed(path)) return deny("code_http_path_forbidden");
  return url;
}
/** All placeholders must be in a version-approved header at its exact origin and path boundary. Never substitutes body or URL. */
export function codeSecretHeaderPlan(
  request: CodeHttpRequest,
  bindings: readonly CodeSecretVersionBinding[],
  ownOrigins: readonly string[],
) {
  const url = codeSecretRequestUrl(request.url, ownOrigins);
  if (request.body?.includes("[secret:")) return deny();
  if ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined) return deny("code_http_invalid_call");
  const seen = new Set<string>();
  const names = new Set<string>();
  for (const [key, value] of Object.entries(request.headers)) {
    const header = key.toLowerCase();
    if (seen.has(header) || !codeSecretHeaderAllowed(header) || /[^\x20-\x7e]/.test(value)) return deny("code_http_invalid_call");
    seen.add(header);
    const markers = [...value.matchAll(/\[secret:([A-Za-z_][A-Za-z0-9_]{0,63})\]/g)];
    if (value.replace(/\[secret:([A-Za-z_][A-Za-z0-9_]{0,63})\]/g, "").includes("[secret:")) return deny();
    for (const marker of markers) {
      const name = marker[1]!;
      const binding = bindings.find((item) => item.name === name);
      const prefix = binding?.pathPrefix;
      if (
        !binding ||
        binding.origin !== url.origin ||
        !binding.headers.includes(header) ||
        !prefix ||
        !(url.pathname === prefix || url.pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"))
      )
        return deny();
      names.add(name);
    }
  }
  return { url, names: [...names] };
}
/** Redact raw, prefixed, JSON-escaped, percent-encoded and base64 echoes before any response or observation is constructed.
 * This is bounded byte replacement, preserving binary responses. Remote services must still be trusted with the credential they receive.
 */
function secretEchoReplacements(inserted: readonly { name: string; value: string; sent: string }[]) {
  const replacements = new Map<string, string>();
  for (const { name, value, sent } of inserted) {
    for (const text of new Set(
      [value, sent].flatMap((text) => [
        text,
        Buffer.from(text).toString("base64"),
        Buffer.from(text).toString("base64url"),
        encodeURIComponent(text),
        JSON.stringify(text).slice(1, -1),
        JSON.stringify(text).slice(1, -1).replaceAll("/", "\\/"),
      ]),
    ))
      if (text) replacements.set(text, `[secret:${name}]`);
  }
  return replacements;
}
export function redactCodeHttpResponse(
  response: Awaited<ReturnType<typeof requestPublicHttps>>,
  inserted: readonly { name: string; value: string; sent: string }[],
) {
  const replacements = secretEchoReplacements(inserted);
  // Latin-1 maps response bytes one-to-one; all inserted values and their encodings are ASCII.
  // Native literal matching avoids a JavaScript pattern scan at every response byte.
  const alternatives = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = alternatives.length ? new RegExp(alternatives.join("|"), "g") : null;
  const replace = (bytes: Uint8Array) => {
    const source = Buffer.from(bytes).toString("latin1");
    let size = bytes.length;
    const text = pattern
      ? source.replace(pattern, (found) => {
          const replacement = replacements.get(found)!;
          size += replacement.length - found.length;
          if (size > CAPABILITY_MAX_RESULT_BYTES) return deny("code_http_result_limit");
          return replacement;
        })
      : source;
    return Buffer.from(text, "latin1");
  };
  const headers = Object.fromEntries(
    Object.entries(response.headers).map(([key, value]) => [key, replace(Buffer.from(value)).toString("utf8")]),
  );
  const result = { status: response.status, headers, body: replace(response.body).toString("base64") };
  if (Buffer.byteLength(JSON.stringify({ ok: true, data: result })) > CAPABILITY_MAX_RESULT_BYTES) return deny("code_http_result_limit");
  return result;
}
const VersionSecretsSchema = z.object({
  secrets: z.array(CodeSecretVersionBindingSchema).optional(),
  internet: CodeInternetOriginsSchema.optional(),
});
/** A declaration never relaxes own-origin or network address protections. The refusal includes only the canonical origin. */
export function requireCodeHttpOrigin(raw: string, declared: readonly string[], own: readonly string[]): URL {
  const url = codeSecretRequestUrl(raw, own);
  if (!CodeInternetOriginSchema.safeParse(url.origin).success) return deny("code_http_origin_forbidden");
  if (!declared.includes(url.origin)) throw new CodeBridgeRefusal("code_http_origin_undeclared", 200, url.origin);
  return url;
}
/** Core dispatcher only. The runner sends markers, Core reads the exact version binding and the current value at issuance.
 * C4 checks policy/fence/mandate and prepares the request in a short transaction. Network I/O starts only after commit.
 */
export async function dispatchCodeSecretHttp(
  input: {
    claims: CodeRunTokenClaims;
    request: CodeHttpRequest;
    authority: CodeBridgeAuthority;
    ownOrigins: readonly string[];
    signal: AbortSignal;
  },
  send: typeof requestPublicHttps = requestPublicHttps,
): Promise<Response> {
  const inserted: { name: string; value: string; sent: string }[] = [];
  try {
    const parsedRequest = CodeHttpRequestSchema.safeParse(input.request);
    if (!parsedRequest.success) return deny("code_http_invalid_call");
    const request = parsedRequest.data;
    const payloadLimit = await codeSettings.get("core.code.payload_bytes");
    if (Buffer.byteLength(JSON.stringify(request)) > payloadLimit) return deny("code_http_input_limit");
    const remaining = input.claims.exp * 1000 - Date.now();
    if (remaining <= 0) return deny("runner_lease_lost");
    return await withNetworkDeadline(remaining, input.signal, new CodeBridgeRefusal("code_http_timeout"), async (signal) => {
      const prepare = async (request: CodeHttpRequest) => {
        const prepared = await sql.begin(async (tx) => {
          const [version] = await tx<{ manifest: unknown }[]>`SELECT jsonb_build_object(
            'secrets',COALESCE(manifest->'secrets','[]'::jsonb),'internet',COALESCE(manifest->'internet','[]'::jsonb)) AS manifest
            FROM code.versions WHERE code_id=${input.claims.codeId} AND id=${input.claims.versionId}::uuid`;
          const parsed = VersionSecretsSchema.safeParse(version?.manifest);
          if (!parsed.success) return deny();
          const bindings = parsed.data.secrets ?? [];
          // Classify an undeclared origin before the origin-bound mandate can return a generic refusal.
          const url = requireCodeHttpOrigin(request.url, parsed.data.internet ?? [], input.ownOrigins);
          const issued = await input.authority.withMandateIssueAuthority(
            {
              mandateId: input.authority.mandateId,
              expectedRevision: input.authority.mandateRevision,
              ownerAppId: "core",
              targetAppId: "core",
              operation: "runtime.http",
              input: { url: request.url, origin: url.origin, method: request.method },
            },
            async () => {
              try {
                await validateCodeSecretBindings(input.claims.codeId, bindings, tx);
                const plan = codeSecretHeaderPlan(request, bindings, input.ownOrigins);
                const values = new Map<string, string>();
                for (const name of plan.names) {
                  // Do not read the mutable binding_revision: only the manifest chooses the destination.
                  const [row] = await tx<{ encrypted: string | null }[]>`SELECT encrypted FROM code.secrets
            WHERE code_id=${input.claims.codeId} AND name=${name} FOR SHARE`;
                  if (!row?.encrypted) return deny("code_http_secret_unavailable");
                  let value: string;
                  try {
                    value = purposeSecretCipher(CODE_SECRET_PURPOSE).decrypt(row.encrypted, codeSecretContext(input.claims.codeId, name));
                  } catch {
                    return deny("code_http_secret_unavailable");
                  }
                  if (!value || /[^\x20-\x7e]/.test(value)) return deny("code_http_secret_unavailable");
                  values.set(name, value);
                }
                const inserted: { name: string; value: string; sent: string }[] = [];
                const headers = Object.fromEntries(
                  Object.entries(request.headers).map(([key, template]) => {
                    const sent = template.replace(
                      /\[secret:([A-Za-z_][A-Za-z0-9_]{0,63})\]/g,
                      (_, name: string) => values.get(name) ?? deny(),
                    );
                    for (const name of plan.names)
                      if (template.includes(`[secret:${name}]`)) inserted.push({ name, value: values.get(name)!, sent });
                    return [key.toLowerCase(), sent];
                  }),
                );
                if (Buffer.byteLength(JSON.stringify(headers)) > payloadLimit) return deny("code_http_input_limit");
                return { ok: true as const, headers, inserted, bindings, origins: parsed.data.internet ?? [] };
              } catch (error) {
                // Expected preparation refusals remain data, so the mandate wrapper cannot erase their codes.
                if (error instanceof CodeBridgeRefusal) return { ok: false as const, code: error.code, origin: error.origin };
                throw error;
              }
            },
            { db: tx },
          );
          return issued.ok ? issued.data : { ok: false as const, code: "code_http_forbidden" };
        });
        if (!prepared.ok) throw new CodeBridgeRefusal(prepared.code, 200, "origin" in prepared ? prepared.origin : undefined);
        return prepared;
      };
      // Locks protect issuance, not the remote effect. A slow endpoint must not block pause, revoke or heartbeats.
      signal.throwIfAborted();
      let current = request;
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        // Every hop rechecks current authority, immutable destinations and current secret values before issuance.
        const prepared = await prepare(current);
        inserted.push(...prepared.inserted);
        const response = await send({
          url: current.url,
          method: current.method,
          headers: prepared.headers,
          body: current.body === undefined ? undefined : Buffer.from(current.body),
          maxBytes: Math.floor((CAPABILITY_MAX_RESULT_BYTES * 3) / 4),
          signal,
          includeRedirectLocation: true,
        });
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.redirectLocation)
          return Response.json({ ok: true, data: redactCodeHttpResponse(response, inserted) });
        if (redirects >= MAX_REDIRECTS) return deny("code_http_redirect_limit");
        const next = new URL(response.redirectLocation, current.url).href;
        requireCodeHttpOrigin(next, prepared.origins, input.ownOrigins);
        const get =
          (response.status === 303 && current.method !== "HEAD") ||
          ((response.status === 301 || response.status === 302) && current.method === "POST");
        current = { ...current, url: next, ...(get ? { method: "GET" as const, body: undefined } : {}) };
      }
    });
  } catch (error) {
    // A remote redirect may echo a credential in its hostname, which URL canonicalization lowercases.
    const origin = error instanceof CodeBridgeRefusal ? error.origin : undefined;
    const safeOrigin =
      origin && ![...secretEchoReplacements(inserted).keys()].some((value) => origin.toLowerCase().includes(value.toLowerCase()));
    // Never forward raw request, response, crypto, cancellation or transport exception text.
    return Response.json({
      ok: false,
      error: {
        code: error instanceof CodeBridgeRefusal ? error.code : "code_http_failed",
        ...(safeOrigin ? { origin } : {}),
      },
    });
  }
}
