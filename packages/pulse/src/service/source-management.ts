import type { ServiceAccount, ServiceAccountCredential, User } from "@k2b/cloud/contracts";
import { err, fail, ok, type PermissionLevel, type Result } from "@k2b/cloud/server";
import { encryptSecret, serviceAccountCredentials, serviceAccounts } from "@k2b/cloud/services";
import { sql } from "bun";
import type { PulseSource, PulseSourceScrape, SourceKind } from "../contracts";
import { withShortId } from "../lib/short-id";
import { type AccessScope, requireBaseAccess, requireBaseActive, type UserScope } from "./access-control";
import { iso, isoNullable } from "./telemetry-values";

export const PULSE_APP_ID = "pulse";
export const PULSE_SOURCE_RESOURCE_TYPE = "pulse_source";
export const PULSE_INGEST_SCOPE = "pulse:ingest";

type SourceRow = {
  id: string;
  short_id: string;
  base_id: string;
  kind: SourceKind;
  name: string;
  enabled: boolean;
  endpoint_url: string | null;
  bearer_token_encrypted: string | null;
  scrape_interval_seconds: number | null;
  last_seen_at: Date | string | null;
  last_error: string | null;
  last_error_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type SourceScrapeRow = {
  id: string;
  source_id: string;
  started_at: Date | string;
  finished_at: Date | string;
  duration_ms: number;
  success: boolean;
  metrics_count: number;
  events_count: number;
  states_count: number;
  error_message: string | null;
};

type PulseSourceApiKey = ServiceAccountCredential & { permission: PermissionLevel };

type UpdateSourceParams = {
  baseId: string;
  sourceId: string;
  user: AccessScope;
  name?: string;
  enabled?: boolean;
  endpointUrl?: string | null;
  bearerToken?: string | null;
  scrapeIntervalSeconds?: number | null;
};

type SourceUpdateValues = {
  name: string;
  enabled: boolean;
  endpointUrl: string | null;
  bearerTokenEncrypted: string | null;
  scrapeIntervalSeconds: number | null;
};

const mapSource = (row: SourceRow): PulseSource => ({
  id: row.id,
  baseId: row.base_id,
  kind: row.kind,
  name: row.name,
  enabled: row.enabled,
  endpointUrl: row.endpoint_url,
  bearerTokenConfigured: Boolean(row.bearer_token_encrypted),
  scrapeIntervalSeconds: row.scrape_interval_seconds,
  lastSeenAt: isoNullable(row.last_seen_at),
  lastError: row.last_error,
  lastErrorAt: isoNullable(row.last_error_at),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const mapSourceScrape = (row: SourceScrapeRow): PulseSourceScrape => ({
  id: row.id,
  sourceId: row.source_id,
  startedAt: iso(row.started_at),
  finishedAt: iso(row.finished_at),
  durationMs: row.duration_ms,
  success: row.success,
  metrics: row.metrics_count,
  events: row.events_count,
  states: row.states_count,
  errorMessage: row.error_message,
});

const normalizeEndpointUrl = (input: string | null | undefined): string | null => {
  const value = input?.trim();
  if (!value) return null;
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const sourceApiKeyPermission = (scopes: string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write") || scopes.includes(PULSE_INGEST_SCOPE)) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

type HttpIngestSource = { source: PulseSource; shortId: string };

const ensureHttpIngestSource = async (params: { baseId: string; sourceId: string }): Promise<Result<HttpIngestSource>> => {
  const [source] = await sql<SourceRow[]>`
    SELECT *
    FROM pulse.sources
    WHERE id = ${params.sourceId}::uuid
      AND base_id = ${params.baseId}::uuid
      AND kind = 'http_ingest'::pulse.source_kind
  `;
  return source ? ok({ source: mapSource(source), shortId: source.short_id }) : fail(err.notFound("Ingest source"));
};

export const listSources = async (
  baseId: string,
  user: AccessScope,
  params: { query?: string | null; limit?: number; offset?: number } = {},
): Promise<Result<PulseSource[]>> => {
  const access = await requireBaseAccess(baseId, user, "read");
  if (!access.ok) return fail(access.error);
  const query = params.query?.trim() || null;
  const pattern = query ? `%${query.replace(/([\\%_])/g, "\\$1")}%` : null;
  const limit = params.limit === undefined ? null : Math.min(500, Math.max(1, params.limit));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<SourceRow[]>`
    SELECT *
    FROM pulse.sources
    WHERE base_id = ${baseId}::uuid
      AND (${pattern}::text IS NULL OR name ILIKE ${pattern} ESCAPE '\\')
    ORDER BY created_at DESC, id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return ok(rows.map(mapSource));
};

export const getSource = async (sourceId: string, user: AccessScope): Promise<Result<PulseSource>> => {
  const [row] = await sql<SourceRow[]>`SELECT * FROM pulse.sources WHERE id = ${sourceId}::uuid`;
  if (!row) return fail(err.notFound("Source"));
  const access = await requireBaseAccess(row.base_id, user, "read");
  return access.ok ? ok(mapSource(row)) : fail(access.error);
};

export const listSourceScrapes = async (params: {
  baseId: string;
  sourceId: string;
  user: AccessScope;
}): Promise<Result<PulseSourceScrape[]>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  const rows = await sql<SourceScrapeRow[]>`
    SELECT id, source_id, started_at, finished_at, duration_ms, success, metrics_count, events_count, states_count, error_message
    FROM pulse.source_scrapes
    WHERE base_id = ${params.baseId}::uuid
      AND source_id = ${params.sourceId}::uuid
    ORDER BY started_at DESC
    LIMIT 10
  `;
  return ok(rows.map(mapSourceScrape));
};

export const createSource = async (params: {
  baseId: string;
  user: AccessScope;
  kind: SourceKind;
  name: string;
  endpointUrl?: string | null;
  bearerToken?: string | null;
  scrapeIntervalSeconds?: number | null;
}): Promise<Result<PulseSource>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);

  const encryptedBearer = params.bearerToken?.trim() ? await encryptSecret(params.bearerToken.trim()) : null;
  const endpointUrl = normalizeEndpointUrl(params.endpointUrl);
  if (params.kind === "metrics" && !endpointUrl) return fail(err.badInput("A valid metrics endpoint URL is required"));

  const row = await withShortId("source", async (shortId) => {
    const [created] = await sql<SourceRow[]>`
    INSERT INTO pulse.sources (
      short_id,
      base_id,
      kind,
      name,
      endpoint_url,
      bearer_token_encrypted,
      scrape_interval_seconds
    )
    VALUES (
      ${shortId},
      ${params.baseId}::uuid,
      ${params.kind}::pulse.source_kind,
      ${params.name.trim()},
      ${endpointUrl},
      ${encryptedBearer},
      ${params.scrapeIntervalSeconds ?? null}
    )
    RETURNING *
  `;
    return created;
  });
  if (!row) return fail(err.internal("Failed to create Pulse source"));
  return ok(mapSource(row));
};

export const removeSource = async (params: { baseId: string; sourceId: string; user: AccessScope }): Promise<Result<void>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const result = await sql.begin(async (tx) => {
    await tx`
      DELETE FROM auth.service_accounts account
      USING pulse.sources source
      WHERE source.id = ${params.sourceId}::uuid
        AND source.base_id = ${params.baseId}::uuid
        AND account.kind = 'resource_bound'
        AND account.app_id = ${PULSE_APP_ID}
        AND account.resource_type = ${PULSE_SOURCE_RESOURCE_TYPE}
        AND account.resource_id = source.short_id
    `;
    const deleted = await tx`
      DELETE FROM pulse.sources
      WHERE id = ${params.sourceId}::uuid
        AND base_id = ${params.baseId}::uuid
    `;
    return deleted.count ?? 0;
  });
  if (result === 0) return fail(err.notFound("Pulse source"));
  return ok();
};

const sourceUpdateName = (existing: SourceRow, name: string | undefined): string => name?.trim() || existing.name;

const sourceUpdateEndpointUrl = (existing: SourceRow, endpointUrl: string | null | undefined): string | null =>
  endpointUrl === undefined ? existing.endpoint_url : normalizeEndpointUrl(endpointUrl);

const sourceUpdateBearerToken = async (existing: SourceRow, bearerToken: string | null | undefined): Promise<string | null> => {
  if (bearerToken === undefined) return existing.bearer_token_encrypted;
  const trimmed = bearerToken?.trim();
  return trimmed ? encryptSecret(trimmed) : null;
};

const normalizeSourceUpdateValues = async (params: UpdateSourceParams, existing: SourceRow): Promise<Result<SourceUpdateValues>> => {
  const endpointUrl = sourceUpdateEndpointUrl(existing, params.endpointUrl);
  if (existing.kind === "metrics" && !endpointUrl) return fail(err.badInput("A valid metrics endpoint URL is required"));
  return ok({
    name: sourceUpdateName(existing, params.name),
    enabled: params.enabled ?? existing.enabled,
    endpointUrl,
    bearerTokenEncrypted: await sourceUpdateBearerToken(existing, params.bearerToken),
    scrapeIntervalSeconds: params.scrapeIntervalSeconds === undefined ? existing.scrape_interval_seconds : params.scrapeIntervalSeconds,
  });
};

export const updateSource = async (params: UpdateSourceParams): Promise<Result<PulseSource>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "write");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const [existing] = await sql<SourceRow[]>`
    SELECT *
    FROM pulse.sources
    WHERE id = ${params.sourceId}::uuid
      AND base_id = ${params.baseId}::uuid
  `;
  if (!existing) return fail(err.notFound("Pulse source"));

  const values = await normalizeSourceUpdateValues(params, existing);
  if (!values.ok) return fail(values.error);

  const [row] = await sql<SourceRow[]>`
    UPDATE pulse.sources
    SET
      name = ${values.data.name},
      enabled = ${values.data.enabled},
      endpoint_url = ${values.data.endpointUrl},
      bearer_token_encrypted = ${values.data.bearerTokenEncrypted},
      scrape_interval_seconds = ${values.data.scrapeIntervalSeconds},
      updated_at = now()
    WHERE id = ${params.sourceId}::uuid
      AND base_id = ${params.baseId}::uuid
    RETURNING *
  `;
  if (!row) return fail(err.internal("Failed to update Pulse source"));
  return ok(mapSource(row));
};

export const listSourceApiKeys = async (params: {
  baseId: string;
  sourceId: string;
  user: UserScope;
}): Promise<Result<PulseSourceApiKey[]>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "admin");
  if (!access.ok) return fail(access.error);
  const source = await ensureHttpIngestSource({ baseId: params.baseId, sourceId: params.sourceId });
  if (!source.ok) return fail(source.error);

  const keys = await serviceAccountCredentials.listOverview({
    pagination: { page: 1, perPage: 500 },
    filter: {
      serviceAccountKind: "resource_bound",
      credentialStatus: "active",
      appId: PULSE_APP_ID,
      resourceType: PULSE_SOURCE_RESOURCE_TYPE,
      resourceId: source.data.shortId,
    },
  });

  return ok(
    keys.items.map((item) => {
      const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
      return { ...credential, permission: sourceApiKeyPermission(credential.scopes) };
    }),
  );
};

export const createSourceApiKey = async (params: {
  baseId: string;
  sourceId: string;
  user: User;
  name: string;
  expiresAt?: string | null;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<{ credential: PulseSourceApiKey; token: string }>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "admin");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const source = await ensureHttpIngestSource({ baseId: params.baseId, sourceId: params.sourceId });
  if (!source.ok) return fail(source.error);
  const name = params.name.trim();
  if (!name) return fail(err.badInput("API key name is required"));
  if (params.permission !== "write") return fail(err.badInput("Source API keys can only use ingest permission"));

  const serviceAccount = await serviceAccounts.getOrCreateResourceBound({
    name: `${source.data.source.name} ingest API keys`,
    appId: PULSE_APP_ID,
    resourceType: PULSE_SOURCE_RESOURCE_TYPE,
    resourceId: source.data.shortId,
    createdBy: params.user.id,
  });
  if (!serviceAccount.ok) return fail(serviceAccount.error);

  const created = await serviceAccountCredentials.createResourceApiToken({
    serviceAccountId: serviceAccount.data.id,
    actor: params.user,
    name,
    expiresAt: params.expiresAt ?? null,
    scopes: [PULSE_INGEST_SCOPE, "write"],
  });
  if (!created.ok) return fail(created.error);

  return ok({
    credential: {
      ...created.data.credential,
      permission: sourceApiKeyPermission(created.data.credential.scopes),
    },
    token: created.data.token,
  });
};

export const removeSourceApiKey = async (params: {
  baseId: string;
  sourceId: string;
  credentialId: string;
  user: User;
}): Promise<Result<void>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "admin");
  if (!access.ok) return fail(access.error);
  const active = await requireBaseActive(params.baseId);
  if (!active.ok) return fail(active.error);
  const keys = await listSourceApiKeys(params);
  if (!keys.ok) return fail(keys.error);
  if (!keys.data.some((key) => key.id === params.credentialId)) return fail(err.notFound("API key"));
  return serviceAccountCredentials.revoke({ credentialId: params.credentialId, actor: params.user });
};

export const resolveIngestSourceForServiceAccount = async (
  serviceAccount: ServiceAccount,
): Promise<Result<{ id: string; baseId: string }>> => {
  if (
    serviceAccount.kind !== "resource_bound" ||
    serviceAccount.appId !== PULSE_APP_ID ||
    serviceAccount.resourceType !== PULSE_SOURCE_RESOURCE_TYPE ||
    !serviceAccount.resourceId
  ) {
    return fail(err.forbidden("API key is not bound to a Pulse ingest source"));
  }
  const [source] = await sql<{ id: string; base_id: string }[]>`
    SELECT s.id, s.base_id
    FROM pulse.sources s
    JOIN pulse.bases b ON b.id = s.base_id
    WHERE s.short_id = ${serviceAccount.resourceId}
      AND s.kind = 'http_ingest'::pulse.source_kind
      AND s.enabled = TRUE
      AND b.deletion_started_at IS NULL
      AND (
        b.data_clear_started_at IS NULL
        OR b.data_clear_completed_at IS NOT NULL
        OR b.data_clear_failed_at IS NOT NULL
      )
  `;
  return source ? ok({ id: source.id, baseId: source.base_id }) : fail(err.notFound("Ingest source"));
};
