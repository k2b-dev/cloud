import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  NetworkTargetBlockedError,
  type PublicNetworkAddress,
  pinnedNetworkLookup,
  resolvePublicNetworkAddresses,
} from "@k2b/cloud/services/network-security";
import { networkAddressFamily, normalizeNetworkHostname } from "@k2b/cloud/shared";
import { sql } from "bun";

export type WebhookEndpoint = {
  id: string;
  token: string;
  name: string;
  urlPath: string;
  requestCount: number;
  lastRequestAt: string | null;
  createdAt: string;
};

export type WebhookLog = {
  id: string;
  endpointId: string | null;
  direction: "incoming" | "outgoing";
  method: string;
  url: string;
  path: string;
  query: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  requestContentType: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
};

export type WebhookSendErrorCode = "UNSUPPORTED_PROTOCOL" | "CREDENTIALS_IN_URL" | "BLOCKED_TARGET" | "OUTGOING_LOG_FAILED";

/**
 * Send-path failure with a stable code. Messages stay English and stable for
 * logs and direct callers; the API boundary maps `code` to a localized
 * human-facing message.
 */
export class WebhookSendError extends Error {
  constructor(
    readonly code: WebhookSendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebhookSendError";
  }
}

export type SendWebhookInput = {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers: Record<string, string>;
  body: string;
};

export type WebhookLogFilters = {
  endpointId?: string | null;
  method?: string | null;
  query?: string | null;
};

type EndpointRow = {
  id: string;
  token: string;
  name: string;
  request_count: number;
  last_request_at: string | null;
  created_at: string;
};

type LogRow = {
  id: string;
  endpoint_id: string | null;
  direction: "incoming" | "outgoing";
  method: string;
  url: string;
  path: string;
  query: string;
  request_headers: Record<string, string>;
  request_body: string | null;
  request_content_type: string | null;
  response_status: number | null;
  response_headers: Record<string, string> | null;
  response_body: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
};

const MAX_BODY_CHARS = 64_000;
const MAX_LOGS_PER_ENDPOINT = 200;
const MAX_OUTGOING_LOGS_PER_USER = 200;
const LOG_RETENTION_DAYS = 30;

const normalizeLogFilters = (filters: WebhookLogFilters = {}) => ({
  endpointId: filters.endpointId?.trim() || null,
  method: filters.method?.trim().toUpperCase() || null,
  query: filters.query?.trim() || null,
});

const redactHeader = (name: string, value: string): string => {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "cookie" || lower === "set-cookie") return "[redacted]";
  return value;
};

export const sanitizeHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = redactHeader(key, value);
  });
  return out;
};

const truncate = (value: string | null | undefined): string | null => {
  if (!value) return value ?? null;
  if (value.length <= MAX_BODY_CHARS) return value;
  return `${value.slice(0, MAX_BODY_CHARS)}\n\n[truncated]`;
};

const createToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

const mapEndpoint = (row: EndpointRow): WebhookEndpoint => ({
  id: row.id,
  token: row.token,
  name: row.name,
  urlPath: `/tools/api/webhooks/receive/${row.token}`,
  requestCount: Number(row.request_count ?? 0),
  lastRequestAt: row.last_request_at,
  createdAt: row.created_at,
});

const mapLog = (row: LogRow): WebhookLog => ({
  id: row.id,
  endpointId: row.endpoint_id,
  direction: row.direction,
  method: row.method,
  url: row.url,
  path: row.path,
  query: row.query,
  requestHeaders: row.request_headers ?? {},
  requestBody: row.request_body,
  requestContentType: row.request_content_type,
  responseStatus: row.response_status,
  responseHeaders: row.response_headers,
  responseBody: row.response_body,
  durationMs: row.duration_ms,
  error: row.error,
  createdAt: row.created_at,
});

type OutgoingWebhookResult = {
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  error: string | null;
};

/** One bounded request, pinned to checked addresses, with no redirect handling. */
export const sendOutgoingWebhookRequest = async (
  input: SendWebhookInput,
  deps: { resolve?: typeof resolvePublicNetworkAddresses } = {},
): Promise<OutgoingWebhookResult> => {
  const url = new URL(input.url);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new WebhookSendError("UNSUPPORTED_PROTOCOL", "Only HTTP and HTTPS URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new WebhookSendError("CREDENTIALS_IN_URL", "URLs with embedded credentials are not allowed.");
  }

  const result: OutgoingWebhookResult = { responseStatus: null, responseHeaders: null, responseBody: null, error: null };
  const controller = new AbortController();
  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("The request timed out.")), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    let addresses: PublicNetworkAddress[];
    try {
      addresses = await Promise.race([(deps.resolve ?? resolvePublicNetworkAddresses)(url.hostname), deadline]);
      if (addresses.length === 0) throw new Error("Empty DNS answer");
    } catch (error) {
      if (error instanceof NetworkTargetBlockedError) {
        throw new WebhookSendError("BLOCKED_TARGET", "Private, local, and link-local targets are blocked.");
      }
      result.error = controller.signal.aborted ? "The request timed out." : "The host name could not be resolved.";
      return result;
    }

    const headers = new Headers(input.headers);
    for (const name of ["host", "content-length", "transfer-encoding", "connection"]) headers.delete(name);
    headers.set("host", url.host);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    if (!headers.has("user-agent")) headers.set("user-agent", "Cloud-Tools-Webhook-Tester");
    const body = input.method === "GET" ? undefined : input.body;
    if (body !== undefined) {
      headers.set("content-length", String(Buffer.byteLength(body)));
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    }

    await Promise.race([
      new Promise<void>((resolve, reject) => {
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          {
            protocol: url.protocol,
            hostname: normalizeNetworkHostname(url.hostname),
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            method: input.method,
            headers: Object.fromEntries(headers),
            lookup: pinnedNetworkLookup(addresses),
            servername: networkAddressFamily(url.hostname) ? undefined : normalizeNetworkHostname(url.hostname),
            rejectUnauthorized: true,
            signal: controller.signal,
            agent: false,
          },
          (response) => {
            result.responseStatus = response.statusCode ?? 0;
            const responseHeaders = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              responseHeaders.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
            }
            result.responseHeaders = sanitizeHeaders(responseHeaders);
            const hasBody = ![204, 205, 304].includes(result.responseStatus);
            const encoding = hasBody ? response.headers["content-encoding"]?.toLowerCase().trim() : undefined;
            const decoder =
              encoding === "gzip"
                ? createGunzip()
                : encoding === "deflate"
                  ? createInflate()
                  : encoding === "br"
                    ? createBrotliDecompress()
                    : null;
            const stream = decoder ?? response;
            const chunks: Buffer[] = [];
            let size = 0;
            let finished = false;
            const finishBody = (truncated: boolean) => {
              if (finished) return;
              finished = true;
              result.responseBody = hasBody
                ? new TextDecoder().decode(Buffer.concat(chunks, size)) + (truncated ? "\n\n[truncated]" : "")
                : null;
              resolve();
            };
            stream.on("data", (chunk: Buffer) => {
              if (finished) return;
              const remaining = MAX_BODY_CHARS - size;
              chunks.push(chunk.subarray(0, remaining));
              size += Math.min(chunk.length, remaining);
              if (chunk.length > remaining) {
                finishBody(true);
                response.unpipe();
                stream.destroy();
                response.destroy();
                request.destroy();
              }
            });
            stream.once("end", () => finishBody(false));
            stream.once("error", (error) => {
              response.destroy();
              request.destroy();
              reject(error);
            });
            response.once("error", (error) => {
              decoder?.destroy();
              reject(error);
            });
            if (decoder) response.pipe(decoder);
          },
        );
        request.once("error", reject);
        request.end(body);
      }),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof WebhookSendError) throw error;
    result.error = controller.signal.aborted ? "The request timed out." : error instanceof Error ? error.message : "Request failed";
  } finally {
    clearTimeout(timer);
  }
  return result;
};

const cleanupLogs = async (ownerUserId: string, endpointId?: string | null) => {
  await sql`
    DELETE FROM tools.webhook_logs
    WHERE owner_user_id = ${ownerUserId}::uuid
      AND created_at < now() - (${LOG_RETENTION_DAYS} || ' days')::interval
  `;

  if (endpointId) {
    await sql`
      DELETE FROM tools.webhook_logs
      WHERE id IN (
        SELECT id
        FROM tools.webhook_logs
        WHERE endpoint_id = ${endpointId}::uuid
        ORDER BY created_at DESC
        OFFSET ${MAX_LOGS_PER_ENDPOINT}
      )
    `;
    return;
  }

  await sql`
    DELETE FROM tools.webhook_logs
    WHERE id IN (
      SELECT id
      FROM tools.webhook_logs
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND direction = 'outgoing'
      ORDER BY created_at DESC
      OFFSET ${MAX_OUTGOING_LOGS_PER_USER}
    )
  `;
};

export const webhookTesterService = {
  async listEndpoints(ownerUserId: string): Promise<WebhookEndpoint[]> {
    const rows: EndpointRow[] = await sql`
      SELECT e.id,
             e.token,
             e.name,
             e.created_at,
             COUNT(l.id)::int AS request_count,
             MAX(l.created_at)::text AS last_request_at
      FROM tools.webhook_endpoints e
      LEFT JOIN tools.webhook_logs l ON l.endpoint_id = e.id
      WHERE e.owner_user_id = ${ownerUserId}::uuid
        AND e.deleted_at IS NULL
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `;
    return rows.map(mapEndpoint);
  },

  async createEndpoint(ownerUserId: string, name: string, fallbackName = "Webhook endpoint"): Promise<WebhookEndpoint> {
    const cleanName = name.trim().slice(0, 120) || fallbackName;
    const [row]: EndpointRow[] = await sql`
      INSERT INTO tools.webhook_endpoints (owner_user_id, token, name)
      VALUES (${ownerUserId}::uuid, ${createToken()}, ${cleanName})
      RETURNING id, token, name, created_at, 0::int AS request_count, NULL::text AS last_request_at
    `;
    if (!row) throw new Error("Endpoint could not be created.");
    return mapEndpoint(row);
  },

  async deleteEndpoint(ownerUserId: string, endpointId: string): Promise<boolean> {
    const rows = await sql`
      UPDATE tools.webhook_endpoints
      SET deleted_at = now()
      WHERE id = ${endpointId}::uuid
        AND owner_user_id = ${ownerUserId}::uuid
        AND deleted_at IS NULL
      RETURNING id
    `;
    return rows.length > 0;
  },

  async listIncomingLogs(ownerUserId: string, filters: WebhookLogFilters = {}): Promise<WebhookLog[]> {
    const clean = normalizeLogFilters(filters);
    const rows: LogRow[] = await sql`
      SELECT *
      FROM tools.webhook_logs
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND direction = 'incoming'
        AND (${clean.endpointId}::uuid IS NULL OR endpoint_id = ${clean.endpointId}::uuid)
        AND (${clean.method}::text IS NULL OR method = ${clean.method})
        AND (
          ${clean.query}::text IS NULL
          OR url ILIKE '%' || ${clean.query} || '%'
          OR path ILIKE '%' || ${clean.query} || '%'
          OR query ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(request_content_type, '') ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(request_body, '') ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(error, '') ILIKE '%' || ${clean.query} || '%'
        )
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return rows.map(mapLog);
  },

  async listEndpointLogs(
    ownerUserId: string,
    endpointId: string,
    filters: Omit<WebhookLogFilters, "endpointId"> = {},
  ): Promise<WebhookLog[]> {
    return webhookTesterService.listIncomingLogs(ownerUserId, { ...filters, endpointId });
  },

  async listOutgoingLogs(ownerUserId: string, filters: WebhookLogFilters = {}): Promise<WebhookLog[]> {
    const clean = normalizeLogFilters(filters);
    const rows: LogRow[] = await sql`
      SELECT *
      FROM tools.webhook_logs
      WHERE owner_user_id = ${ownerUserId}::uuid
        AND direction = 'outgoing'
        AND (${clean.method}::text IS NULL OR method = ${clean.method})
        AND (
          ${clean.query}::text IS NULL
          OR url ILIKE '%' || ${clean.query} || '%'
          OR path ILIKE '%' || ${clean.query} || '%'
          OR query ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(request_content_type, '') ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(request_body, '') ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(response_body, '') ILIKE '%' || ${clean.query} || '%'
          OR COALESCE(error, '') ILIKE '%' || ${clean.query} || '%'
        )
      ORDER BY created_at DESC
      LIMIT 100
    `;
    return rows.map(mapLog);
  },

  async logIncoming(params: {
    token: string;
    method: string;
    url: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    body: string | null;
    contentType: string | null;
  }): Promise<WebhookLog | null> {
    const [endpoint]: { id: string; owner_user_id: string }[] = await sql`
      SELECT id, owner_user_id
      FROM tools.webhook_endpoints
      WHERE token = ${params.token}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!endpoint) return null;

    const [row]: LogRow[] = await sql`
      INSERT INTO tools.webhook_logs (
        endpoint_id,
        owner_user_id,
        direction,
        method,
        url,
        path,
        query,
        request_headers,
        request_body,
        request_content_type,
        response_status
      )
      VALUES (
        ${endpoint.id}::uuid,
        ${endpoint.owner_user_id}::uuid,
        'incoming',
        ${params.method},
        ${params.url},
        ${params.path},
        ${params.query},
        ${JSON.stringify(params.headers)}::text::jsonb,
        ${truncate(params.body)},
        ${params.contentType},
        200
      )
      RETURNING *
    `;
    if (!row) throw new Error("Incoming request could not be logged.");
    await cleanupLogs(endpoint.owner_user_id, endpoint.id);
    return mapLog(row);
  },

  async send(ownerUserId: string, input: SendWebhookInput): Promise<WebhookLog> {
    const parsedUrl = new URL(input.url);
    const headers = new Headers(input.headers);
    const started = performance.now();
    const { responseStatus, responseHeaders, responseBody, error } = await sendOutgoingWebhookRequest(input);

    const [row]: LogRow[] = await sql`
      INSERT INTO tools.webhook_logs (
        owner_user_id,
        direction,
        method,
        url,
        path,
        query,
        request_headers,
        request_body,
        request_content_type,
        response_status,
        response_headers,
        response_body,
        duration_ms,
        error
      )
      VALUES (
        ${ownerUserId}::uuid,
        'outgoing',
        ${input.method},
        ${parsedUrl.toString()},
        ${parsedUrl.pathname},
        ${parsedUrl.search},
        ${JSON.stringify(sanitizeHeaders(headers))}::text::jsonb,
        ${input.method === "GET" ? null : truncate(input.body)},
        ${headers.get("content-type")},
        ${responseStatus},
        ${responseHeaders ? JSON.stringify(responseHeaders) : null}::text::jsonb,
        ${responseBody},
        ${Math.round(performance.now() - started)},
        ${error}
      )
      RETURNING *
    `;
    if (!row) throw new WebhookSendError("OUTGOING_LOG_FAILED", "Outgoing request could not be logged.");
    await cleanupLogs(ownerUserId, null);
    return mapLog(row);
  },
};
