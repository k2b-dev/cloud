import { err, fail, ok, type Result } from "@k2b/stdlib";
import { redis, sql } from "bun";
import { HTTPException } from "hono/http-exception";
import { hasRole, type User } from "../../contracts/shared";
import { z } from "zod";
import { AnnouncementDisplayEntrySchema } from "../../contracts/announcements";
import { claimCacheFill, completeCacheFill } from "../cache-fill";
import type {
  AnnouncementCookieState,
  AnnouncementDisplayEntry,
  AnnouncementEntry,
  CreateAnnouncement,
  UpdateAnnouncement,
} from "../../contracts/announcements";
import { markdown } from "../../shared/markdown";
import { logger } from "../logging";

const log = logger("announcements");
const ACTIVE_CACHE_KEY = "appglobalcache:shared:announcements:v1";
const invalidateActiveCache = () => redis.del(ACTIVE_CACHE_KEY);
const invalidateAfterMutation = async () => {
  try {
    await invalidateActiveCache();
  } catch (error) {
    // The database mutation already succeeded; do not invite duplicate creates.
    // Unavailable Redis reads fall back to Postgres; old cache entries expire.
    log.warn("Announcement saved but cache invalidation failed", { error: error instanceof Error ? error.message : String(error) });
  }
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnnouncementRow = {
  id: string;
  version: number;
  kind: "announcement" | "banner";
  title: string;
  body: string;
  tone: "info" | "success" | "warning" | "danger";
  published_at: Date;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  updated_by: string | null;
};

type ListAdminConfig = {
  filter?: {
    kind?: "announcement" | "banner";
    query?: string;
  };
};

const mapRow = (row: AnnouncementRow): AnnouncementEntry => ({
  id: row.id,
  version: row.version,
  kind: row.kind,
  title: row.title,
  body: row.body,
  tone: row.tone,
  publishedAt: row.published_at.toISOString(),
  expiresAt: row.expires_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  createdBy: row.created_by,
  updatedBy: row.updated_by,
});

export const renderAnnouncement = (entry: AnnouncementEntry): AnnouncementDisplayEntry => {
  const { body, ...rest } = entry;
  return { ...rest, bodyHtml: markdown.renderSync(body) };
};

const validateDates = (input: Pick<CreateAnnouncement | UpdateAnnouncement, "publishedAt" | "expiresAt">) => {
  const publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (publishedAt && Number.isNaN(publishedAt.getTime())) return fail(err.badInput("Invalid publish date."));
  if (expiresAt && Number.isNaN(expiresAt.getTime())) return fail(err.badInput("Invalid expiry date."));
  if (publishedAt && expiresAt && expiresAt.getTime() <= publishedAt.getTime()) {
    return fail(err.badInput("Expiry date must be after publish date."));
  }
  return ok({ publishedAt, expiresAt });
};

const listAdmin = async (config: ListAdminConfig = {}): Promise<AnnouncementEntry[]> => {
  const kind = config.filter?.kind;
  const query = config.filter?.query?.trim();
  const search = query ? `%${query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%` : null;

  const rows = await sql<AnnouncementRow[]>`
    SELECT id, version, kind, title, body, tone, published_at, expires_at,
      created_at, updated_at, created_by, updated_by
    FROM announcements.entries
    WHERE (${kind ?? null}::text IS NULL OR kind = ${kind ?? null})
      AND (
        ${search}::text IS NULL
        OR title ILIKE ${search} ESCAPE '\\'
        OR body ILIKE ${search} ESCAPE '\\'
      )
    ORDER BY published_at DESC, version DESC
  `;
  return rows.map(mapRow);
};

const get = async (params: { id: string }): Promise<AnnouncementEntry | null> => {
  if (!UUID_PATTERN.test(params.id)) return null;
  const [row] = await sql<AnnouncementRow[]>`
    SELECT id, version, kind, title, body, tone, published_at, expires_at,
      created_at, updated_at, created_by, updated_by
    FROM announcements.entries
    WHERE id = ${params.id}::uuid
  `;
  return row ? mapRow(row) : null;
};

const create = async (params: { data: CreateAnnouncement; actorId: string }): Promise<Result<AnnouncementEntry>> => {
  const dateResult = validateDates(params.data);
  if (!dateResult.ok) return dateResult;

  try {
    const [row] = await sql<AnnouncementRow[]>`
      INSERT INTO announcements.entries (
        kind, title, body, tone, published_at, expires_at, created_by, updated_by
      )
      VALUES (
        ${params.data.kind},
        ${params.data.title},
        ${params.data.body},
        ${params.data.tone},
        COALESCE(${params.data.publishedAt ?? null}::timestamptz, now()),
        ${params.data.expiresAt ?? null}::timestamptz,
        ${params.actorId}::uuid,
        ${params.actorId}::uuid
      )
      RETURNING id, version, kind, title, body, tone, published_at, expires_at,
        created_at, updated_at, created_by, updated_by
    `;
    if (row) await invalidateAfterMutation();
    return row ? ok(mapRow(row)) : fail(err.internal("Failed to create announcement."));
  } catch (error) {
    log.error("Failed to create announcement", { error: error instanceof Error ? error.message : String(error) });
    return fail(err.internal("Failed to create announcement."));
  }
};

const update = async (params: { id: string; data: UpdateAnnouncement; actorId: string }): Promise<Result<AnnouncementEntry>> => {
  if (!UUID_PATTERN.test(params.id)) return fail(err.notFound("Announcement"));

  try {
    const existing = await get({ id: params.id });
    if (!existing) return fail(err.notFound("Announcement"));
    const dateResult = validateDates({
      publishedAt: params.data.publishedAt ?? existing.publishedAt,
      expiresAt: "expiresAt" in params.data ? params.data.expiresAt : existing.expiresAt,
    });
    if (!dateResult.ok) return dateResult;

    const [row] = await sql<AnnouncementRow[]>`
      UPDATE announcements.entries
      SET
        kind = COALESCE(${params.data.kind ?? null}, kind),
        title = COALESCE(${params.data.title ?? null}, title),
        body = COALESCE(${params.data.body ?? null}, body),
        tone = COALESCE(${params.data.tone ?? null}, tone),
        published_at = COALESCE(${params.data.publishedAt ?? null}::timestamptz, published_at),
        expires_at = CASE
          WHEN ${"expiresAt" in params.data} THEN ${params.data.expiresAt ?? null}::timestamptz
          ELSE expires_at
        END,
        updated_at = now(),
        updated_by = ${params.actorId}::uuid
      WHERE id = ${params.id}::uuid
      RETURNING id, version, kind, title, body, tone, published_at, expires_at,
        created_at, updated_at, created_by, updated_by
    `;
    if (row) await invalidateAfterMutation();
    return row ? ok(mapRow(row)) : fail(err.notFound("Announcement"));
  } catch (error) {
    log.error("Failed to update announcement", { id: params.id, error: error instanceof Error ? error.message : String(error) });
    return fail(err.internal("Failed to update announcement."));
  }
};

const remove = async (params: { id: string }): Promise<Result<void>> => {
  if (!UUID_PATTERN.test(params.id)) return fail(err.notFound("Announcement"));
  const result = await sql`DELETE FROM announcements.entries WHERE id = ${params.id}::uuid`;
  if (result.count > 0) await invalidateAfterMutation();
  return result.count > 0 ? ok() : fail(err.notFound("Announcement"));
};

const listActive = async (params: { now?: Date } = {}): Promise<AnnouncementEntry[]> => {
  const now = params.now ?? new Date();
  const rows = await sql<AnnouncementRow[]>`
    SELECT id, version, kind, title, body, tone, published_at, expires_at,
      created_at, updated_at, created_by, updated_by
    FROM announcements.entries
    WHERE published_at <= ${now}
      AND (expires_at IS NULL OR expires_at > ${now})
    ORDER BY version DESC
  `;
  return rows.map(mapRow);
};

const selectEntriesForState = <T extends { kind: AnnouncementEntry["kind"]; version: number }>(
  entries: T[],
  state: AnnouncementCookieState,
) => {
  const dismissedBanners = new Set(state.dismissedBannerVersions);
  const activeAnnouncements = entries.filter((entry) => entry.kind === "announcement");
  const latestAnnouncementVersion = activeAnnouncements.reduce((max, entry) => Math.max(max, entry.version), state.seenAnnouncementVersion);
  return {
    banners: entries
      .filter((entry) => entry.kind === "banner" && !dismissedBanners.has(entry.version))
      .sort((a, b) => b.version - a.version),
    announcements: activeAnnouncements
      .filter((entry) => entry.version > state.seenAnnouncementVersion)
      .sort((a, b) => b.version - a.version),
    latestAnnouncementVersion,
  };
};

export const selectVisibleForState = (entries: AnnouncementEntry[], state: AnnouncementCookieState) => {
  const selected = selectEntriesForState(entries, state);
  return { ...selected, banners: selected.banners.map(renderAnnouncement), announcements: selected.announcements.map(renderAnnouncement) };
};

const cachedActive = async (): Promise<AnnouncementDisplayEntry[]> => {
  let cached: string | null = null;
  try {
    cached = await redis.get(ACTIVE_CACHE_KEY);
  } catch {
    /* Read authoritative data below. */
  }
  let entries: AnnouncementDisplayEntry[] | undefined;
  if (cached !== null) {
    try {
      entries = z.array(AnnouncementDisplayEntrySchema).parse(JSON.parse(cached));
    } catch {
      /* Miss. */
    }
  }
  if (!entries) {
    const lease = await claimCacheFill(ACTIVE_CACHE_KEY, cached);
    // Include scheduled entries: publish/expiry boundaries are applied at read time.
    const rows = await sql<AnnouncementRow[]>`
      SELECT id, version, kind, title, body, tone, published_at, expires_at,
        created_at, updated_at, created_by, updated_by
      FROM announcements.entries
      WHERE expires_at IS NULL OR expires_at > now()
      ORDER BY version DESC
    `;
    entries = rows.map((row) => renderAnnouncement(mapRow(row)));
    await completeCacheFill(ACTIVE_CACHE_KEY, lease, JSON.stringify(entries), 300);
  }
  const now = Date.now();
  return entries.filter((entry) => Date.parse(entry.publishedAt) <= now && (!entry.expiresAt || Date.parse(entry.expiresAt) > now));
};

const activeForState = async (params: { state: AnnouncementCookieState; now?: Date }) =>
  params.now
    ? selectVisibleForState(await listActive({ now: params.now }), params.state)
    : selectEntriesForState(await cachedActive(), params.state);

export const announcements = {
  admin: {
    list: listAdmin,
    get,
    create,
    update,
    remove,
    invalidateCache: async (actor: User | undefined) => {
      if (!actor || !hasRole(actor, "admin")) throw new HTTPException(403, { message: "Administrator access required" });
      await invalidateActiveCache();
    },
  },
  active: {
    list: listActive,
    forState: activeForState,
    selectForState: selectVisibleForState,
  },
  render: renderAnnouncement,
};

export type AnnouncementsService = typeof announcements;
