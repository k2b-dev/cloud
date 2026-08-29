import { dates } from "@k2b/stdlib";
import {
  type AccessEntry,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  err,
  fail,
  getEffectivePermission,
  hasPermission,
  ok,
  type PermissionLevel,
  type Principal,
  type Result,
  resolveDisplayNames,
  updateAccess,
} from "@valentinkolb/cloud/server";
import { logger, serviceAccounts } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { z } from "zod";
import { permissionFromVenueScopes, type VenueAccessScope } from "./access-control";
import { buildPublicAvailability } from "./availability";
import type {
  DateOverride,
  DateOverrideInput,
  FeedbackEntry,
  FeedbackInputSchema,
  FeedbackSummary,
  FreeSignupInputSchema,
  OpeningRule,
  OpeningRuleInput,
  PublicSection,
  PublicSectionInput,
  PublicStatus,
  ShiftAssignment,
  ShiftTemplate,
  ShiftTemplateInput,
  TemplateSignupInputSchema,
  UpcomingSlot,
  Venue,
  VenueDashboard,
  VenueInput,
  VenueTemplateCreateInput,
  VenueTemplateSummary,
} from "./contracts";
import { withShortIdDb } from "./lib/short-id";
import { venueMessages } from "./messages";
import { filterPublicMenuSections } from "./public-menu";
import * as publicProjection from "./service/public-projection";
import { resolvePublicId, resolveVenuePublicId } from "./service/public-resources";
import { getVenueTemplate, listVenueTemplates as localizedVenueTemplates } from "./templates";

const log = logger("venue:service");
const VENUE_APP_ID = "venue";
const VENUE_RESOURCE_TYPE = "venue";

type DbVenue = {
  id: string;
  short_id: string;
  slug: string;
  name: string;
  icon: string;
  description: string | null;
  timezone: string;
  open_mode: Venue["openMode"];
  signup_mode: Venue["signupMode"];
  public_enabled: boolean;
  feedback_enabled: boolean;
  accent_color: string;
  logo_base64: string | null;
  banner_base64: string | null;
  ical_token: string;
  created_at: Date;
  updated_at: Date;
};

type DbOpeningRule = {
  id: string;
  short_id: string;
  venue_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  note: string | null;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type DbDateOverride = {
  id: string;
  short_id: string;
  venue_id: string;
  date: string | Date;
  kind: "closed" | "open";
  start_time: string | null;
  end_time: string | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbShiftTemplate = {
  id: string;
  short_id: string;
  venue_id: string;
  weekday: number;
  title: string;
  start_time: string;
  end_time: string;
  min_people: number;
  max_people: number | null;
  require_target_for_opening: boolean;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type DbShiftAssignment = {
  id: string;
  short_id: string;
  venue_id: string;
  template_id: string | null;
  user_id: string;
  user_display_name: string | null;
  starts_at: Date;
  ends_at: Date;
  note: string | null;
  created_at: Date;
  updated_at: Date;
};

type DbShiftAssignmentSummary = {
  template_id: string | null;
  starts_at: Date;
  ends_at: Date;
  assigned_count: number;
  current_user_assignment_id: string | null;
};

export type ShiftAssignmentSummary = {
  templateId: string | null;
  startsAt: string;
  endsAt: string;
  assignedCount: number;
  currentUserAssignmentId: string | null;
};

type InternalUpcomingSlot = UpcomingSlot & { key: string };
export type InternalVenueDashboard = Omit<VenueDashboard, "slots"> & { slots: InternalUpcomingSlot[] };
export type UpcomingSlotSummary = Omit<UpcomingSlot, "assignments"> & {
  key: string;
  currentUserAssignmentId: string | null;
};

type DbPublicSection = {
  id: string;
  short_id: string;
  venue_id: string;
  kind: PublicSection["kind"];
  title: string;
  content: Record<string, unknown> | string | null;
  enabled: boolean;
  position: number;
  created_at: Date;
  updated_at: Date;
};

type DbFeedbackEntry = {
  id: string;
  venue_id: string;
  rating: number;
  comment: string | null;
  created_at: Date;
};

type UserLike = {
  id: string;
};

type VenueAccessSubject = {
  subject: VenueAccessScope["subject"];
  serviceAccountResourceId?: string | null;
  serviceAccountScopes?: string[];
};

type ResultError = Extract<Result<unknown>, { ok: false }>["error"];
type SqlClient = typeof sql;

class TemplateError extends Error {
  constructor(public readonly resultError: ResultError) {
    super(resultError.message);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b);

const toAccessSubject = (subject: UserLike | VenueAccessSubject): VenueAccessSubject =>
  "subject" in subject
    ? subject
    : {
        subject: { type: "user", userId: subject.id },
        serviceAccountResourceId: null,
        serviceAccountScopes: [],
      };

const toDateKey = (value: string | Date): string => {
  if (value instanceof Date) return dates.formatDateKey(value, { timeZone: "UTC" });
  return value.slice(0, 10);
};

const toTime = (value: string | null): string | null => (value ? value.slice(0, 5) : null);

const mapVenue = (row: DbVenue, permission?: PermissionLevel): Venue => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  icon: row.icon || "ti ti-building-carousel",
  description: row.description,
  timezone: row.timezone,
  openMode: row.open_mode,
  signupMode: row.signup_mode,
  publicEnabled: row.public_enabled,
  feedbackEnabled: row.feedback_enabled,
  accentColor: row.accent_color,
  logoBase64: row.logo_base64,
  bannerBase64: row.banner_base64,
  icalToken: row.ical_token,
  permission,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapOpeningRule = (row: DbOpeningRule): OpeningRule => ({
  id: row.id,
  venueId: row.venue_id,
  weekday: row.weekday,
  startTime: toTime(row.start_time) ?? "00:00",
  endTime: toTime(row.end_time) ?? "00:00",
  note: row.note,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapOverride = (row: DbDateOverride): DateOverride => ({
  id: row.id,
  venueId: row.venue_id,
  date: toDateKey(row.date),
  kind: row.kind,
  startTime: toTime(row.start_time),
  endTime: toTime(row.end_time),
  note: row.note,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapTemplate = (row: DbShiftTemplate): ShiftTemplate => ({
  id: row.id,
  venueId: row.venue_id,
  weekday: row.weekday,
  title: row.title,
  startTime: toTime(row.start_time) ?? "00:00",
  endTime: toTime(row.end_time) ?? "00:00",
  minPeople: row.min_people,
  maxPeople: row.max_people,
  requireTargetForOpening: row.require_target_for_opening,
  active: row.active,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapAssignment = (row: DbShiftAssignment): ShiftAssignment => ({
  id: row.id,
  venueId: row.venue_id,
  templateId: row.template_id,
  userId: row.user_id,
  userDisplayName: row.user_display_name ?? "Unknown user",
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
  note: row.note,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapSection = (row: DbPublicSection): PublicSection => ({
  id: row.id,
  venueId: row.venue_id,
  kind: row.kind,
  title: row.title,
  content: typeof row.content === "string" ? (JSON.parse(row.content) as Record<string, unknown>) : (row.content ?? {}),
  enabled: row.enabled,
  position: row.position,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const mapFeedback = (row: DbFeedbackEntry): FeedbackEntry => ({
  venueId: row.venue_id,
  rating: row.rating,
  comment: row.comment,
  createdAt: row.created_at.toISOString(),
});

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "venue";

const resolveAvailableVenueSlug = async (baseSlug: string): Promise<string> => {
  const base = slugify(baseSlug);
  const rows = await sql<{ slug: string }[]>`
    SELECT slug FROM venue.venues
    WHERE slug = ${base} OR slug LIKE ${`${base}-%`}
  `;
  const existing = new Set(rows.map((row) => row.slug));
  if (!existing.has(base)) return base;

  for (let suffix = 2; suffix < 10_000; suffix++) {
    const suffixPart = `-${suffix}`;
    const candidate = `${base.slice(0, 80 - suffixPart.length)}${suffixPart}`;
    if (!existing.has(candidate)) return candidate;
  }

  return `${base.slice(0, 67)}-${crypto.randomUUID().slice(0, 12)}`;
};

const localDateKey = (instant: Date, timezone: string): string => dates.formatDateKey(instant, { timeZone: timezone });

const localWeekday = (dateKey: string): number => {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day === 0 ? 0 : day;
};

const instantFor = (date: string, time: string, timezone: string): Date =>
  new Date(dates.zonedDateTimeToInstant(`${date}T${time}`, timezone, { disambiguation: "compatible" }));

const endInstantFor = (date: string, startTime: string, endTime: string, timezone: string): Date => {
  const endDate = endTime <= startTime ? dateKeyAfterDays(date, 1, timezone) : date;
  return instantFor(endDate, endTime, timezone);
};

const dateKeyAfterDays = (date: string, days: number, timezone: string): string =>
  dates.formatDateKey(new Date(instantFor(date, "12:00", timezone).getTime() + days * 86_400_000), { timeZone: timezone });

const escapeIcs = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

const icsDate = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const listAccess = async (venueId: string): Promise<AccessEntry[]> => {
  const rows = await sql<
    {
      access_id: string;
      user_id: string | null;
      group_id: string | null;
      service_account_id: string | null;
      authenticated_only: boolean;
      permission: PermissionLevel;
      created_at: Date;
    }[]
  >`
    SELECT a.id AS access_id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
    FROM venue.venue_access va
    JOIN auth.access a ON a.id = va.access_id
    WHERE va.venue_id = ${venueId}::uuid
    ORDER BY a.created_at
  `;

  return resolveDisplayNames(
    rows.map((row) => ({
      id: row.access_id,
      principal: row.user_id
        ? { type: "user", userId: row.user_id }
        : row.group_id
          ? { type: "group", groupId: row.group_id }
          : row.service_account_id
            ? { type: "service_account", serviceAccountId: row.service_account_id }
            : row.authenticated_only
              ? { type: "authenticated" }
              : { type: "public" },
      permission: row.permission,
      createdAt: row.created_at.toISOString(),
    })),
  );
};

const createOwnerAccessInTx = async (tx: SqlClient, userId: string): Promise<Result<{ id: string }>> => {
  const [user] = await tx<{ id: string }[]>`SELECT id FROM auth.users WHERE id = ${userId}::uuid`;
  if (!user) return fail(err.notFound("User"));

  const [row] = await tx<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission)
    VALUES (${userId}::uuid, 'admin'::auth.permission_level)
    RETURNING id
  `;
  return row ? ok({ id: row.id }) : fail(err.internal("Failed to create access entry"));
};

const getPermission = async (venueId: string, subjectInput: UserLike | VenueAccessSubject): Promise<PermissionLevel> => {
  const subject = toAccessSubject(subjectInput);
  if (
    subject.subject.type === "service_account" &&
    (!UUID_PATTERN.test(subject.serviceAccountResourceId ?? "") || subject.serviceAccountResourceId !== venueId)
  ) {
    return "none";
  }

  const entries = await listAccess(venueId);
  const permission = await getEffectivePermission({
    accessIds: entries.map((entry) => entry.id),
    subject: subject.subject,
  });
  return subject.subject.type === "service_account"
    ? minPermission(permission, permissionFromVenueScopes(subject.serviceAccountScopes))
    : permission;
};

const requirePermission = async (
  venueId: string,
  subject: UserLike | VenueAccessSubject,
  required: PermissionLevel,
): Promise<Result<PermissionLevel>> => {
  const permission = await getPermission(venueId, subject);
  if (!hasPermission(permission, required)) return fail(err.forbidden("You do not have access to this venue"));
  return ok(permission);
};

const listVenues = async (subjectInput: UserLike | VenueAccessSubject): Promise<Venue[]> => {
  const subject = toAccessSubject(subjectInput);
  if (subject.subject.type === "service_account" && !UUID_PATTERN.test(subject.serviceAccountResourceId ?? "")) {
    return [];
  }

  const principalMatch = buildAccessPrincipalCondition({
    subject: subject.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const bindingMatch = subject.subject.type === "service_account" ? sql`v.id = ${subject.serviceAccountResourceId}::uuid` : sql`true`;

  const rows = await sql<DbVenue[]>`
    SELECT DISTINCT v.*
    FROM venue.venues v
    JOIN venue.venue_access va ON va.venue_id = v.id
    JOIN auth.access a ON a.id = va.access_id
    WHERE
      a.permission <> 'none'
      AND ${principalMatch}
      AND ${bindingMatch}
    ORDER BY v.name
  `;

  const venues: Venue[] = [];
  for (const row of rows) {
    venues.push(mapVenue(row, await getPermission(row.id, subject)));
  }
  return venues.filter((venue) => venue.permission && venue.permission !== "none");
};

type VenueDiscoveryOptions = {
  query?: string | null;
  limit?: number;
  offset?: number;
};

const venueSearchPattern = (query: string | null | undefined): string | null => {
  const value = query?.trim();
  return value ? `%${value.replace(/([\\%_])/g, "\\$1")}%` : null;
};

const discoverVenues = async (subjectInput: UserLike | VenueAccessSubject, options: VenueDiscoveryOptions = {}): Promise<Venue[]> => {
  const subject = toAccessSubject(subjectInput);
  if (subject.subject.type === "service_account" && !UUID_PATTERN.test(subject.serviceAccountResourceId ?? "")) return [];

  const principalMatch = buildAccessPrincipalCondition({
    subject: subject.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const bindingMatch = subject.subject.type === "service_account" ? sql`v.id = ${subject.serviceAccountResourceId}::uuid` : sql`true`;
  const pattern = venueSearchPattern(options.query);
  const limit = Math.min(101, Math.max(1, options.limit ?? 25));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = await sql<DbVenue[]>`
    SELECT DISTINCT
      v.id, v.slug, v.name, v.icon, v.description, v.timezone, v.open_mode, v.signup_mode,
      v.public_enabled, v.feedback_enabled, v.accent_color,
      NULL::text AS logo_base64, NULL::text AS banner_base64, ''::text AS ical_token,
      v.created_at, v.updated_at
    FROM venue.venues v
    JOIN venue.venue_access va ON va.venue_id = v.id
    JOIN auth.access a ON a.id = va.access_id
    WHERE a.permission <> 'none'
      AND ${principalMatch}
      AND ${bindingMatch}
      AND (${pattern}::text IS NULL OR v.name ILIKE ${pattern} ESCAPE '\\' OR v.slug ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(v.description, '') ILIKE ${pattern} ESCAPE '\\')
    ORDER BY v.name, v.id
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const venues: Venue[] = [];
  for (const row of rows) venues.push(mapVenue(row, await getPermission(row.id, subject)));
  return venues.filter((venue) => venue.permission && venue.permission !== "none");
};

const discoverPublicVenues = async (options: VenueDiscoveryOptions = {}): Promise<Venue[]> => {
  const pattern = venueSearchPattern(options.query);
  const limit = Math.min(101, Math.max(1, options.limit ?? 25));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = await sql<DbVenue[]>`
    SELECT
      v.id, v.slug, v.name, v.icon, v.description, v.timezone, v.open_mode, v.signup_mode,
      v.public_enabled, v.feedback_enabled, v.accent_color,
      NULL::text AS logo_base64, NULL::text AS banner_base64, ''::text AS ical_token,
      v.created_at, v.updated_at
    FROM venue.venues v
    WHERE v.public_enabled = true
      AND (${pattern}::text IS NULL OR v.name ILIKE ${pattern} ESCAPE '\\' OR v.slug ILIKE ${pattern} ESCAPE '\\'
        OR COALESCE(v.description, '') ILIKE ${pattern} ESCAPE '\\')
    ORDER BY v.name, v.id
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map((row) => mapVenue(row));
};

const getVenue = async (id: string, subject?: UserLike | VenueAccessSubject): Promise<Venue | null> => {
  const [row] = await sql<DbVenue[]>`SELECT * FROM venue.venues WHERE id = ${id}::uuid`;
  if (!row) return null;
  return mapVenue(row, subject ? await getPermission(row.id, subject) : undefined);
};

const getVenueSummary = async (id: string, subject?: UserLike | VenueAccessSubject): Promise<Venue | null> => {
  const [row] = await sql<DbVenue[]>`
    SELECT
      v.id, v.slug, v.name, v.icon, v.description, v.timezone, v.open_mode, v.signup_mode,
      v.public_enabled, v.feedback_enabled, v.accent_color,
      NULL::text AS logo_base64, NULL::text AS banner_base64, ''::text AS ical_token,
      v.created_at, v.updated_at
    FROM venue.venues v
    WHERE v.id = ${id}::uuid
  `;
  if (!row) return null;
  return mapVenue(row, subject ? await getPermission(row.id, subject) : undefined);
};

const getVenueByShortId = async (shortId: string, subject?: UserLike | VenueAccessSubject): Promise<Venue | null> => {
  const id = await resolvePublicId("venues", shortId);
  return id ? getVenue(id, subject) : null;
};

const createVenueInTx = async (tx: SqlClient, input: VenueInput, user: UserLike): Promise<Result<Venue>> => {
  const rows = await withShortIdDb(
    tx,
    "venue",
    (db, shortId) => db<DbVenue[]>`
      INSERT INTO venue.venues (
        short_id, slug, name, icon, description, timezone, open_mode, signup_mode, public_enabled,
        feedback_enabled, accent_color, logo_base64, banner_base64
      )
      VALUES (
        ${shortId}, ${slugify(input.slug)}, ${input.name.trim()}, ${input.icon || "ti ti-building-carousel"}, ${input.description?.trim() || null},
        ${input.timezone || "Europe/Berlin"}, ${input.openMode}, ${input.signupMode},
        ${input.publicEnabled}, ${input.feedbackEnabled}, ${input.accentColor},
        ${input.logoBase64 || null}, ${input.bannerBase64 || null}
      )
      RETURNING *
    `,
  );
  const row = rows[0];
  if (!row) return fail(err.internal("Failed to create venue"));

  const access = await createOwnerAccessInTx(tx, user.id);
  if (!access.ok) return access;

  await tx`
      INSERT INTO venue.venue_access (venue_id, access_id)
      VALUES (${row.id}::uuid, ${access.data.id}::uuid)
    `;
  log.info("Venue created", { venueId: row.id, userId: user.id });
  return ok(mapVenue(row, "admin"));
};

const createVenue = async (input: VenueInput, user: UserLike): Promise<Result<Venue>> => {
  return sql.begin((tx) => createVenueInTx(tx, input, user));
};

const listVenueTemplates = (locale?: string): VenueTemplateSummary[] => localizedVenueTemplates(locale);

const requireTemplateResult = <T>(result: Result<T>): T => {
  if (!result.ok) throw new TemplateError(result.error);
  return result.data;
};

const instantiateVenueTemplate = async (
  templateId: string,
  input: VenueTemplateCreateInput,
  user: UserLike,
  locale?: string,
): Promise<Result<Venue>> => {
  const template = getVenueTemplate(templateId, locale);
  if (!template) return fail(err.notFound("Template"));

  const name = input.name?.trim() || template.venue.name;
  const slug = await resolveAvailableVenueSlug(input.slug?.trim() || name || template.venue.slug);

  try {
    return await sql.begin(async (tx) => {
      const venue = await createVenueInTx(
        tx,
        {
          ...template.venue,
          name,
          slug,
        },
        user,
      );
      if (!venue.ok) return venue;

      for (const rule of template.openingRules) {
        requireTemplateResult(await createOpeningRuleInTx(tx, venue.data.id, rule));
      }
      for (const shift of template.shifts) {
        requireTemplateResult(await createTemplateInTx(tx, venue.data.id, shift));
      }
      for (const [index, section] of template.sections.entries()) {
        requireTemplateResult(await createSectionInTx(tx, venue.data.id, { ...section, position: index + 1 }));
      }
      return venue;
    });
  } catch (error) {
    log.error("Venue template instantiation failed", {
      templateId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof TemplateError) return fail(error.resultError);
    return fail(err.internal("Could not create venue from template."));
  }
};

const createOpeningRuleInTx = async (tx: SqlClient, venueId: string, input: OpeningRuleInput): Promise<Result<OpeningRule>> => {
  const rows = await withShortIdDb(
    tx,
    "openingRule",
    (db, shortId) => db<DbOpeningRule[]>`
    INSERT INTO venue.opening_rules (short_id, venue_id, weekday, start_time, end_time, note)
    VALUES (${shortId}, ${venueId}::uuid, ${input.weekday}, ${input.startTime}::time, ${input.endTime}::time, ${input.note?.trim() || null})
    RETURNING *
  `,
  );
  const row = rows[0];
  return row ? ok(mapOpeningRule(row)) : fail(err.internal("Failed to create opening rule"));
};

const createTemplateInTx = async (tx: SqlClient, venueId: string, input: ShiftTemplateInput): Promise<Result<ShiftTemplate>> => {
  const rows = await withShortIdDb(
    tx,
    "template",
    (db, shortId) => db<DbShiftTemplate[]>`
    INSERT INTO venue.shift_templates (
      short_id, venue_id, weekday, title, start_time, end_time, min_people, max_people,
      require_target_for_opening, active
    )
    VALUES (
      ${shortId}, ${venueId}::uuid, ${input.weekday}, ${input.title.trim()}, ${input.startTime}::time, ${input.endTime}::time,
      ${input.minPeople}, ${input.maxPeople ?? null}, ${input.requireTargetForOpening}, ${input.active}
    )
    RETURNING *
  `,
  );
  const row = rows[0];
  return row ? ok(mapTemplate(row)) : fail(err.internal("Failed to create shift"));
};

const createSectionInTx = async (tx: SqlClient, venueId: string, input: PublicSectionInput): Promise<Result<PublicSection>> => {
  const rows = await withShortIdDb(
    tx,
    "section",
    (db, shortId) => db<DbPublicSection[]>`
    INSERT INTO venue.public_sections (short_id, venue_id, kind, title, content, enabled, position)
    VALUES (${shortId}, ${venueId}::uuid, ${input.kind}, ${input.title.trim()}, ${JSON.stringify(input.content)}::jsonb, ${input.enabled}, ${input.position})
    RETURNING *
  `,
  );
  const row = rows[0];
  return row ? ok(mapSection(row)) : fail(err.internal("Failed to create public section"));
};

const updateVenue = async (id: string, input: VenueInput): Promise<Result<Venue>> => {
  const [row] = await sql<DbVenue[]>`
    UPDATE venue.venues
    SET
      slug = ${slugify(input.slug)},
      name = ${input.name.trim()},
      icon = ${input.icon || "ti ti-building-carousel"},
      description = ${input.description?.trim() || null},
      timezone = ${input.timezone || "Europe/Berlin"},
      open_mode = ${input.openMode},
      signup_mode = ${input.signupMode},
      public_enabled = ${input.publicEnabled},
      feedback_enabled = ${input.feedbackEnabled},
      accent_color = ${input.accentColor},
      logo_base64 = ${input.logoBase64 || null},
      banner_base64 = ${input.bannerBase64 || null},
      updated_at = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return row ? ok(mapVenue(row)) : fail(err.notFound("Venue"));
};

const deleteVenue = async (id: string): Promise<Result<void>> => {
  const result = await sql`
    DELETE FROM venue.venues
    WHERE id = ${id}::uuid
  `;
  if (result.count === 0) return fail(err.notFound("Venue"));

  await serviceAccounts.deleteForResource({
    appId: VENUE_APP_ID,
    resourceType: VENUE_RESOURCE_TYPE,
    resourceId: id,
  });
  return ok();
};

const grantAccess = async (venueId: string, principal: Principal, permission: PermissionLevel): Promise<Result<AccessEntry>> => {
  const existing = await listAccess(venueId);
  const duplicate = existing.find((entry) => JSON.stringify(entry.principal) === JSON.stringify(principal));
  if (duplicate) return fail(err.conflict("Access entry"));

  const created = await createAccess({ principal, permission });
  if (!created.ok) return created;

  try {
    await sql`INSERT INTO venue.venue_access (venue_id, access_id) VALUES (${venueId}::uuid, ${created.data.id}::uuid)`;
  } catch (error) {
    await deleteAccess({ id: created.data.id });
    throw error;
  }

  const entries = await listAccess(venueId);
  const entry = entries.find((candidate) => candidate.id === created.data.id);
  return entry ? ok(entry) : fail(err.internal("Failed to retrieve access entry"));
};

const changeAccess = async (venueId: string, accessId: string, permission: PermissionLevel): Promise<Result<AccessEntry>> => {
  const entries = await listAccess(venueId);
  if (!entries.some((entry) => entry.id === accessId)) return fail(err.notFound("Access entry"));
  const updated = await updateAccess({ id: accessId, permission });
  if (!updated.ok) return updated;
  const next = await listAccess(venueId);
  const entry = next.find((candidate) => candidate.id === accessId);
  return entry ? ok(entry) : fail(err.internal("Failed to retrieve access entry"));
};

const revokeAccess = async (venueId: string, accessId: string): Promise<Result<void>> => {
  const entries = await listAccess(venueId);
  const target = entries.find((entry) => entry.id === accessId);
  if (!target) return fail(err.notFound("Access entry"));
  const remainingAdmins = entries.filter((entry) => entry.id !== accessId && entry.permission === "admin").length;
  if (target.permission === "admin" && remainingAdmins === 0) return fail(err.badInput("A venue needs at least one admin"));
  await deleteAccess({ id: accessId });
  return ok();
};

const listOpeningRules = async (venueId: string): Promise<OpeningRule[]> => {
  const rows = await sql<DbOpeningRule[]>`
    SELECT * FROM venue.opening_rules
    WHERE venue_id = ${venueId}::uuid
    ORDER BY weekday, start_time
  `;
  return rows.map(mapOpeningRule);
};

const createOpeningRule = async (venueId: string, input: OpeningRuleInput): Promise<Result<OpeningRule>> => {
  return createOpeningRuleInTx(sql, venueId, input);
};

const updateOpeningRule = async (venueId: string, id: string, input: OpeningRuleInput): Promise<Result<OpeningRule>> => {
  const [row] = await sql<DbOpeningRule[]>`
    UPDATE venue.opening_rules
    SET weekday = ${input.weekday},
        start_time = ${input.startTime}::time,
        end_time = ${input.endTime}::time,
        note = ${input.note?.trim() || null},
        updated_at = now()
    WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid
    RETURNING *
  `;
  return row ? ok(mapOpeningRule(row)) : fail(err.notFound("Opening rule"));
};

const deleteOpeningRule = async (venueId: string, id: string): Promise<Result<void>> => {
  await sql`DELETE FROM venue.opening_rules WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid`;
  return ok();
};

const listOverrides = async (venueId: string, days = 60): Promise<DateOverride[]> => {
  const rows = await sql<DbDateOverride[]>`
    SELECT * FROM venue.date_overrides
    WHERE venue_id = ${venueId}::uuid
      AND date >= CURRENT_DATE - INTERVAL '7 days'
      AND date <= CURRENT_DATE + (${days}::int * INTERVAL '1 day')
    ORDER BY date
  `;
  return rows.map(mapOverride);
};

const listOverridesForDateRange = async (venueId: string, startDate: string, endDate: string): Promise<DateOverride[]> => {
  const rows = await sql<DbDateOverride[]>`
    SELECT * FROM venue.date_overrides
    WHERE venue_id = ${venueId}::uuid
      AND date >= ${startDate}::date
      AND date < ${endDate}::date
    ORDER BY date
  `;
  return rows.map(mapOverride);
};

const upsertOverride = async (venueId: string, input: DateOverrideInput): Promise<Result<DateOverride>> => {
  const rows = await withShortIdDb(
    sql,
    "override",
    (db, shortId) => db<DbDateOverride[]>`
    INSERT INTO venue.date_overrides (short_id, venue_id, date, kind, start_time, end_time, note)
    VALUES (
      ${shortId}, ${venueId}::uuid, ${input.date}::date, ${input.kind},
      ${input.kind === "open" ? input.startTime : null}::time,
      ${input.kind === "open" ? input.endTime : null}::time,
      ${input.note?.trim() || null}
    )
    ON CONFLICT (venue_id, date)
    DO UPDATE SET kind = EXCLUDED.kind, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, note = EXCLUDED.note, updated_at = now()
    RETURNING *
  `,
  );
  const row = rows[0];
  return row ? ok(mapOverride(row)) : fail(err.internal("Failed to save override"));
};

const updateOverride = async (venueId: string, id: string, input: DateOverrideInput): Promise<Result<DateOverride>> => {
  const [row] = await sql<DbDateOverride[]>`
    UPDATE venue.date_overrides
    SET date = ${input.date}::date,
        kind = ${input.kind},
        start_time = ${input.kind === "open" ? input.startTime : null}::time,
        end_time = ${input.kind === "open" ? input.endTime : null}::time,
        note = ${input.note?.trim() || null},
        updated_at = now()
    WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid
    RETURNING *
  `;
  return row ? ok(mapOverride(row)) : fail(err.notFound("Date override"));
};

const deleteOverride = async (venueId: string, id: string): Promise<Result<void>> => {
  await sql`DELETE FROM venue.date_overrides WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid`;
  return ok();
};

const listTemplates = async (venueId: string, options: { limit?: number } = {}): Promise<ShiftTemplate[]> => {
  const limit = options.limit === undefined ? null : Math.min(101, Math.max(1, options.limit));
  const rows = await sql<DbShiftTemplate[]>`
    SELECT * FROM venue.shift_templates
    WHERE venue_id = ${venueId}::uuid
      AND active = true
    ORDER BY weekday, start_time, id
    LIMIT ${limit}
  `;
  return rows.map(mapTemplate);
};

const getTemplate = async (id: string): Promise<ShiftTemplate | null> => {
  const [row] = await sql<DbShiftTemplate[]>`SELECT * FROM venue.shift_templates WHERE id = ${id}::uuid`;
  return row ? mapTemplate(row) : null;
};

const createTemplate = async (venueId: string, input: ShiftTemplateInput): Promise<Result<ShiftTemplate>> => {
  return createTemplateInTx(sql, venueId, input);
};

const updateTemplate = async (venueId: string, id: string, input: ShiftTemplateInput): Promise<Result<ShiftTemplate>> => {
  const [row] = await sql<DbShiftTemplate[]>`
    UPDATE venue.shift_templates
    SET weekday = ${input.weekday},
        title = ${input.title.trim()},
        start_time = ${input.startTime}::time,
        end_time = ${input.endTime}::time,
        min_people = ${input.minPeople},
        max_people = ${input.maxPeople ?? null},
        require_target_for_opening = ${input.requireTargetForOpening},
        active = ${input.active},
        updated_at = now()
    WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid
    RETURNING *
  `;
  return row ? ok(mapTemplate(row)) : fail(err.notFound("Shift"));
};

const deleteTemplate = async (venueId: string, id: string): Promise<Result<void>> => {
  await sql`UPDATE venue.shift_templates SET active = false, updated_at = now() WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid`;
  return ok();
};

const assignmentsForRange = async (venueId: string, start: Date, end: Date): Promise<ShiftAssignment[]> => {
  const rows = await sql<DbShiftAssignment[]>`
    SELECT sa.*, u.display_name AS user_display_name
    FROM venue.shift_assignments sa
    JOIN auth.users u ON u.id = sa.user_id
    WHERE sa.venue_id = ${venueId}::uuid
      AND sa.starts_at < ${end}
      AND sa.ends_at > ${start}
    ORDER BY sa.starts_at, u.display_name
  `;
  return rows.map(mapAssignment);
};

const assignmentSummariesForRange = async (
  venueId: string,
  start: Date,
  end: Date,
  currentUserId: string | null = null,
): Promise<ShiftAssignmentSummary[]> => {
  const rows = await sql<DbShiftAssignmentSummary[]>`
    SELECT
      sa.template_id,
      sa.starts_at,
      sa.ends_at,
      COUNT(*)::int AS assigned_count,
      MIN(sa.id::text) FILTER (
        WHERE ${currentUserId}::uuid IS NOT NULL AND sa.user_id = ${currentUserId}::uuid
      ) AS current_user_assignment_id
    FROM venue.shift_assignments sa
    WHERE sa.venue_id = ${venueId}::uuid
      AND sa.starts_at < ${end}
      AND sa.ends_at > ${start}
    GROUP BY sa.template_id, sa.starts_at, sa.ends_at
    ORDER BY sa.starts_at, sa.ends_at, sa.template_id
  `;
  return rows.map((row) => ({
    templateId: row.template_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    assignedCount: row.assigned_count,
    currentUserAssignmentId: row.current_user_assignment_id,
  }));
};

type PersonalShiftAssignment = ShiftAssignment & {
  venueName: string;
  venueTimezone: string;
};

const listPersonalAssignments = async (
  userId: string,
  options: { venueId?: string; from: Date; to: Date; limit?: number; offset?: number },
): Promise<PersonalShiftAssignment[]> => {
  const limit = Math.min(101, Math.max(1, options.limit ?? 25));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = await sql<(DbShiftAssignment & { venue_name: string; venue_timezone: string })[]>`
    SELECT sa.*, u.display_name AS user_display_name, v.name AS venue_name, v.timezone AS venue_timezone
    FROM venue.shift_assignments sa
    JOIN auth.users u ON u.id = sa.user_id
    JOIN venue.venues v ON v.id = sa.venue_id
    WHERE sa.user_id = ${userId}::uuid
      AND (${options.venueId ?? null}::uuid IS NULL OR sa.venue_id = ${options.venueId ?? null}::uuid)
      AND sa.starts_at < ${options.to}
      AND sa.ends_at > ${options.from}
    ORDER BY sa.starts_at, sa.id
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map((row) => ({ ...mapAssignment(row), venueName: row.venue_name, venueTimezone: row.venue_timezone }));
};

type UpcomingSlotsOptions = {
  startDate?: string;
  days?: number;
  templates?: ShiftTemplate[];
};

const templatesByWeekday = (templates: ShiftTemplate[]): Map<number, ShiftTemplate[]> => {
  const grouped = new Map<number, ShiftTemplate[]>();
  for (const template of templates) {
    const entries = grouped.get(template.weekday);
    if (entries) entries.push(template);
    else grouped.set(template.weekday, [template]);
  }
  return grouped;
};

const assignmentsByTemplateSlot = (assignments: ShiftAssignment[]): Map<string, ShiftAssignment[]> => {
  const grouped = new Map<string, ShiftAssignment[]>();
  for (const assignment of assignments) {
    if (!assignment.templateId) continue;
    const key = `${assignment.templateId}:${assignment.startsAt}`;
    const entries = grouped.get(key);
    if (entries) entries.push(assignment);
    else grouped.set(key, [assignment]);
  }
  return grouped;
};

const slotForTemplate = (venue: Venue, template: ShiftTemplate, date: string, slotAssignments: ShiftAssignment[]): InternalUpcomingSlot => {
  const startsAt = instantFor(date, template.startTime, venue.timezone).toISOString();
  const endsAt = endInstantFor(date, template.startTime, template.endTime, venue.timezone).toISOString();
  const assignedCount = slotAssignments.length;
  return {
    key: `${template.id}:${date}`,
    date,
    template,
    startsAt,
    endsAt,
    assignedCount,
    minPeople: template.minPeople,
    maxPeople: template.maxPeople,
    missingPeople: Math.max(0, template.minPeople - assignedCount),
    full: template.maxPeople !== null && assignedCount >= template.maxPeople,
    assignments: slotAssignments,
  };
};

const upcomingSlots = async (venue: Venue, options: number | UpcomingSlotsOptions = 14): Promise<InternalUpcomingSlot[]> => {
  const config = typeof options === "number" ? { days: options } : options;
  const days = Math.max(0, config.days ?? 14);
  if (days === 0) return [];

  const templates = (config.templates ?? (await listTemplates(venue.id))).filter((template) => template.active);
  if (templates.length === 0) return [];

  const startDate = config.startDate ?? localDateKey(new Date(), venue.timezone);
  const rangeStart = instantFor(startDate, "00:00", venue.timezone);
  const rangeEnd = new Date(rangeStart.getTime() + days * 86_400_000);
  const assignments = await assignmentsForRange(venue.id, rangeStart, rangeEnd);
  const templatesForWeekday = templatesByWeekday(templates);
  const assignmentsBySlot = assignmentsByTemplateSlot(assignments);

  const slots: InternalUpcomingSlot[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = dateKeyAfterDays(startDate, offset, venue.timezone);
    const weekdayTemplates = templatesForWeekday.get(localWeekday(date));
    if (!weekdayTemplates) continue;

    for (const template of weekdayTemplates) {
      const startsAt = instantFor(date, template.startTime, venue.timezone).toISOString();
      const slotAssignments = assignmentsBySlot.get(`${template.id}:${startsAt}`) ?? [];
      slots.push(slotForTemplate(venue, template, date, slotAssignments));
    }
  }
  return slots;
};

const upcomingSlotSummaries = async (
  venue: Venue,
  options: UpcomingSlotsOptions & { currentUserId?: string | null },
): Promise<UpcomingSlotSummary[]> => {
  const days = Math.max(0, options.days ?? 14);
  if (days === 0) return [];

  const templates = (options.templates ?? (await listTemplates(venue.id))).filter((template) => template.active);
  if (templates.length === 0) return [];

  const startDate = options.startDate ?? localDateKey(new Date(), venue.timezone);
  const rangeStart = instantFor(startDate, "00:00", venue.timezone);
  const rangeEnd = new Date(rangeStart.getTime() + days * 86_400_000);
  const summaries = await assignmentSummariesForRange(venue.id, rangeStart, rangeEnd, options.currentUserId ?? null);
  const summariesBySlot = new Map(
    summaries.filter((summary) => summary.templateId).map((summary) => [`${summary.templateId}:${summary.startsAt}`, summary]),
  );
  const templatesForWeekday = templatesByWeekday(templates);
  const slots: UpcomingSlotSummary[] = [];

  for (let offset = 0; offset < days; offset++) {
    const date = dateKeyAfterDays(startDate, offset, venue.timezone);
    const weekdayTemplates = templatesForWeekday.get(localWeekday(date));
    if (!weekdayTemplates) continue;
    for (const template of weekdayTemplates) {
      const startsAt = instantFor(date, template.startTime, venue.timezone).toISOString();
      const endsAt = endInstantFor(date, template.startTime, template.endTime, venue.timezone).toISOString();
      const summary = summariesBySlot.get(`${template.id}:${startsAt}`);
      const assignedCount = summary?.assignedCount ?? 0;
      slots.push({
        key: `${template.id}:${date}`,
        date,
        template,
        startsAt,
        endsAt,
        assignedCount,
        minPeople: template.minPeople,
        maxPeople: template.maxPeople,
        missingPeople: Math.max(0, template.minPeople - assignedCount),
        full: template.maxPeople !== null && assignedCount >= template.maxPeople,
        currentUserAssignmentId: summary?.currentUserAssignmentId ?? null,
      });
    }
  }
  return slots;
};

const signupTemplate = async (
  venue: Venue,
  templateId: string,
  input: z.infer<typeof TemplateSignupInputSchema>,
  user: UserLike,
): Promise<Result<ShiftAssignment>> => {
  return sql.begin(async (tx) => {
    const [template] = await tx<DbShiftTemplate[]>`
      SELECT * FROM venue.shift_templates
      WHERE id = ${templateId}::uuid AND venue_id = ${venue.id}::uuid AND active = true
    `;
    if (!template) return fail(err.notFound("Shift"));

    const startTime = toTime(template.start_time) ?? "00:00";
    const endTime = toTime(template.end_time) ?? "00:00";
    if (localWeekday(input.date) !== template.weekday) {
      return fail(err.badInput("The selected date does not match this shift's weekday"));
    }
    const start = instantFor(input.date, startTime, venue.timezone);
    const end = endInstantFor(input.date, startTime, endTime, venue.timezone);
    if (end < new Date()) return fail(err.badInput("This shift has already ended"));

    await tx`SELECT pg_advisory_xact_lock(hashtext(${templateId}), hashtext(${start.toISOString()}))`;

    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM venue.shift_assignments
      WHERE venue_id = ${venue.id}::uuid
        AND user_id = ${user.id}::uuid
        AND starts_at = ${start}
        AND ends_at = ${end}
      LIMIT 1
    `;
    if (existing) return fail(err.badInput("You are already signed up for this shift"));

    const rows = await withShortIdDb(
      tx,
      "assignment",
      (db, shortId) => db<DbShiftAssignment[]>`
      INSERT INTO venue.shift_assignments (short_id, venue_id, template_id, user_id, starts_at, ends_at)
      SELECT ${shortId}, ${venue.id}::uuid, t.id, ${user.id}::uuid, ${start}, ${end}
      FROM venue.shift_templates t
      WHERE t.id = ${templateId}::uuid
        AND t.venue_id = ${venue.id}::uuid
        AND t.active = true
        AND (
          t.max_people IS NULL
          OR (
            SELECT COUNT(*)::int
            FROM venue.shift_assignments sa
            WHERE sa.template_id = t.id AND sa.starts_at = ${start}
          ) < t.max_people
        )
      RETURNING *, NULL::text AS user_display_name
    `,
    );
    const row = rows[0];
    if (!row) return fail(err.badInput("This shift is already full"));
    return ok((await assignmentsForRange(venue.id, start, end)).find((entry) => entry.id === row.id) ?? mapAssignment(row));
  });
};

const signupTemplateWeeks = async (
  venue: Venue,
  templateId: string,
  date: string,
  weeks: number,
  user: UserLike,
): Promise<Result<ShiftAssignment[]>> => {
  const created: ShiftAssignment[] = [];
  for (let week = 0; week < weeks; week++) {
    const nextDate = dates.formatDateKey(new Date(instantFor(date, "12:00", venue.timezone).getTime() + week * 7 * 86_400_000), {
      timeZone: venue.timezone,
    });
    const result = await signupTemplate(venue, templateId, { date: nextDate }, user);
    if (result.ok) created.push(result.data);
  }
  return ok(created);
};

const signupFree = async (
  venueId: string,
  input: z.infer<typeof FreeSignupInputSchema>,
  user: UserLike,
): Promise<Result<ShiftAssignment>> => {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (!(start < end)) return fail(err.badInput("Start must be before end"));
  if (end < new Date()) return fail(err.badInput("This shift has already ended"));

  const rows = await withShortIdDb(
    sql,
    "assignment",
    (db, shortId) => db<DbShiftAssignment[]>`
    INSERT INTO venue.shift_assignments (short_id, venue_id, user_id, starts_at, ends_at, note)
    VALUES (${shortId}, ${venueId}::uuid, ${user.id}::uuid, ${start}, ${end}, ${input.note?.trim() || null})
    ON CONFLICT (venue_id, user_id, starts_at, ends_at) DO NOTHING
    RETURNING *, NULL::text AS user_display_name
  `,
  );
  const row = rows[0];
  return row
    ? ok((await assignmentsForRange(venueId, start, end)).find((entry) => entry.id === row.id) ?? mapAssignment(row))
    : fail(err.badInput("You are already signed up for this time range"));
};

const cancelAssignment = async (venueId: string, assignmentId: string, user: UserLike, canAdmin: boolean): Promise<Result<void>> => {
  const rows = await sql<{ user_id: string }[]>`
    DELETE FROM venue.shift_assignments
    WHERE venue_id = ${venueId}::uuid
      AND id = ${assignmentId}::uuid
      AND (${canAdmin} OR user_id = ${user.id}::uuid)
    RETURNING user_id
  `;
  return rows.length > 0 ? ok() : fail(err.notFound("Shift assignment"));
};

const getPersonalAssignment = async (venueId: string, assignmentId: string, userId: string): Promise<ShiftAssignment | null> => {
  const [row] = await sql<DbShiftAssignment[]>`
    SELECT sa.*, u.display_name AS user_display_name
    FROM venue.shift_assignments sa
    JOIN auth.users u ON u.id = sa.user_id
    WHERE sa.venue_id = ${venueId}::uuid
      AND sa.id = ${assignmentId}::uuid
      AND sa.user_id = ${userId}::uuid
  `;
  return row ? mapAssignment(row) : null;
};

const getPersonalAssignmentById = async (assignmentId: string, userId: string): Promise<PersonalShiftAssignment | null> => {
  const [row] = await sql<(DbShiftAssignment & { venue_name: string; venue_timezone: string })[]>`
    SELECT sa.*, u.display_name AS user_display_name, v.name AS venue_name, v.timezone AS venue_timezone
    FROM venue.shift_assignments sa
    JOIN auth.users u ON u.id = sa.user_id
    JOIN venue.venues v ON v.id = sa.venue_id
    WHERE sa.id = ${assignmentId}::uuid AND sa.user_id = ${userId}::uuid
  `;
  return row ? { ...mapAssignment(row), venueName: row.venue_name, venueTimezone: row.venue_timezone } : null;
};

const listSections = async (venueId: string, onlyEnabled = false): Promise<PublicSection[]> => {
  const rows = await sql<DbPublicSection[]>`
    SELECT * FROM venue.public_sections
    WHERE venue_id = ${venueId}::uuid
      AND (${!onlyEnabled} OR enabled = true)
    ORDER BY position, created_at
  `;
  return rows.map(mapSection);
};

const createSection = async (venueId: string, input: PublicSectionInput): Promise<Result<PublicSection>> => {
  return createSectionInTx(sql, venueId, input);
};

const updateSection = async (venueId: string, id: string, input: PublicSectionInput): Promise<Result<PublicSection>> => {
  const [row] = await sql<DbPublicSection[]>`
    UPDATE venue.public_sections
    SET kind = ${input.kind},
        title = ${input.title.trim()},
        content = ${JSON.stringify(input.content)}::jsonb,
        enabled = ${input.enabled},
        position = ${input.position},
        updated_at = now()
    WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid
    RETURNING *
  `;
  return row ? ok(mapSection(row)) : fail(err.notFound("Public section"));
};

const deleteSection = async (venueId: string, id: string): Promise<Result<void>> => {
  await sql`DELETE FROM venue.public_sections WHERE venue_id = ${venueId}::uuid AND id = ${id}::uuid`;
  return ok();
};

const createFeedback = async (venueId: string, input: z.infer<typeof FeedbackInputSchema>): Promise<Result<FeedbackEntry>> => {
  const [venue] = await sql<{ public_enabled: boolean; feedback_enabled: boolean }[]>`
    SELECT public_enabled, feedback_enabled FROM venue.venues WHERE id = ${venueId}::uuid
  `;
  if (!venue?.public_enabled) return fail(err.notFound("Venue"));
  if (!venue?.feedback_enabled) return fail(err.badInput("Feedback is disabled for this venue"));
  const [row] = await sql<DbFeedbackEntry[]>`
    INSERT INTO venue.feedback_entries (venue_id, rating, comment)
    VALUES (${venueId}::uuid, ${input.rating}, ${input.comment?.trim() || null})
    RETURNING *
  `;
  return row ? ok(mapFeedback(row)) : fail(err.internal("Failed to submit feedback"));
};

const feedbackSummary = async (
  venueId: string,
  options: { includeEntries?: boolean; entryDays?: number; entrySearch?: string; summaryDays?: number } = {},
): Promise<{ summary: FeedbackSummary; entries: FeedbackEntry[] }> => {
  const summaryDays = options.summaryDays === undefined ? null : Math.max(1, Math.min(30, options.summaryDays));
  const [summary] = await sql<{ count: number; average_rating: number | null }[]>`
    SELECT COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 2)::float AS average_rating
    FROM venue.feedback_entries
    WHERE venue_id = ${venueId}::uuid
      AND (${summaryDays}::int IS NULL OR created_at >= now() - (${summaryDays}::text || ' days')::interval)
  `;
  const buckets = await sql<{ date: string | Date; count: number; average_rating: number | null }[]>`
    SELECT created_at::date AS date, COUNT(*)::int AS count, ROUND(AVG(rating)::numeric, 2)::float AS average_rating
    FROM venue.feedback_entries
    WHERE venue_id = ${venueId}::uuid
      AND created_at >= now() - (${summaryDays ?? 30}::text || ' days')::interval
    GROUP BY created_at::date
    ORDER BY created_at::date
  `;
  const entryDays = Math.max(1, Math.min(30, options.entryDays ?? 30));
  const entrySearch = options.entrySearch?.trim();
  const entries = options.includeEntries
    ? entrySearch
      ? await sql<DbFeedbackEntry[]>`
      SELECT * FROM venue.feedback_entries
      WHERE venue_id = ${venueId}::uuid
        AND created_at >= now() - (${entryDays}::text || ' days')::interval
        AND COALESCE(comment, '') ILIKE ${`%${entrySearch}%`}
      ORDER BY created_at DESC
      LIMIT 200
    `
      : await sql<DbFeedbackEntry[]>`
      SELECT * FROM venue.feedback_entries
      WHERE venue_id = ${venueId}::uuid
        AND created_at >= now() - (${entryDays}::text || ' days')::interval
      ORDER BY created_at DESC
      LIMIT 200
    `
    : [];
  return {
    summary: {
      count: summary?.count ?? 0,
      averageRating: summary?.average_rating ?? null,
      buckets: buckets.map((bucket) => ({ date: toDateKey(bucket.date), count: bucket.count, averageRating: bucket.average_rating })),
    },
    entries: entries.map(mapFeedback),
  };
};

const statusForVenue = async (venue: Venue, now = new Date(), includeSections = true, locale?: string): Promise<PublicStatus> => {
  const { t } = venueMessages.resolve(locale ? [locale] : []);
  const days = 14;
  const startDate = localDateKey(now, venue.timezone);
  const endDate = dateKeyAfterDays(startDate, days, venue.timezone);
  const rangeEnd = instantFor(endDate, "00:00", venue.timezone);
  const [openingRules, overrides, templates, assignments, sections] = await Promise.all([
    listOpeningRules(venue.id),
    listOverridesForDateRange(venue.id, startDate, endDate),
    listTemplates(venue.id),
    assignmentSummariesForRange(venue.id, new Date(now.getTime() - 1), rangeEnd),
    includeSections ? listSections(venue.id, true) : Promise.resolve([]),
  ]);
  const availability = buildPublicAvailability({ venue, openingRules, overrides, templates, assignments, now, days, locale });

  return {
    venue,
    ...availability,
    statusLabel: availability.open ? t.openNow : t.closedNow,
    openingRules,
    sections: filterPublicMenuSections(sections, startDate),
  };
};

const publicStatus = async (shortId: string, now = new Date(), locale?: string): Promise<PublicStatus | null> => {
  const venue = await getVenueByShortId(shortId);
  return venue?.publicEnabled ? statusForVenue(venue, now, true, locale) : null;
};

export type VenueDashboardOptions = {
  slotStartDate?: string;
  slotDays?: number;
  includeFeedbackEntries?: boolean;
  feedbackDays?: number;
  feedbackSearch?: string;
};

const dashboard = async (venue: Venue, user: UserLike | null, options: VenueDashboardOptions = {}): Promise<InternalVenueDashboard> => {
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 86_400_000);
  const slotDays = Math.max(0, options.slotDays ?? 14);
  const [openingRules, overrides, templates, assignments, sections, feedback, myShiftCount] = await Promise.all([
    listOpeningRules(venue.id),
    listOverrides(venue.id),
    listTemplates(venue.id),
    assignmentsForRange(venue.id, start, end),
    listSections(venue.id),
    feedbackSummary(venue.id, {
      includeEntries: options.includeFeedbackEntries ?? false,
      entryDays: options.feedbackDays,
      entrySearch: options.feedbackSearch,
    }),
    user
      ? sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM venue.shift_assignments
      WHERE venue_id = ${venue.id}::uuid
        AND user_id = ${user.id}::uuid
    `.then((rows) => rows[0]?.count ?? 0)
      : Promise.resolve(0),
  ]);
  const [slots] = await Promise.all([
    slotDays > 0 ? upcomingSlots(venue, { startDate: options.slotStartDate, days: slotDays, templates }) : Promise.resolve([]),
  ]);

  return {
    venue,
    openingRules,
    overrides,
    templates,
    slots,
    assignments,
    myUpcomingShifts: user ? assignments.filter((assignment) => assignment.userId === user.id) : [],
    myShiftCount,
    sections,
    feedback: feedback.summary,
    feedbackEntries: feedback.entries,
  };
};

const getOrCreateIcalToken = async (userId: string): Promise<string> => {
  const [row] = await sql<{ token: string }[]>`
    INSERT INTO venue.user_ical_tokens (user_id)
    VALUES (${userId}::uuid)
    ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
    RETURNING token
  `;
  if (!row) throw new Error("Failed to create iCal token");
  return row.token;
};

const getUserIdByIcalToken = async (token: string): Promise<string | null> => {
  const [row] = await sql<{ user_id: string }[]>`
    SELECT user_id FROM venue.user_ical_tokens WHERE token = ${token}
  `;
  return row?.user_id ?? null;
};

const generateUserIcs = async (userId: string, baseUrl: string): Promise<string> => {
  const rows = await sql<(DbShiftAssignment & { venue_name: string; venue_short_id: string })[]>`
    SELECT sa.*, u.display_name AS user_display_name, v.name AS venue_name, v.short_id AS venue_short_id
    FROM venue.shift_assignments sa
    JOIN venue.venues v ON v.id = sa.venue_id
    JOIN auth.users u ON u.id = sa.user_id
    WHERE sa.user_id = ${userId}::uuid
      AND sa.ends_at >= now() - INTERVAL '30 days'
    ORDER BY sa.starts_at
  `;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StuVe Cloud//Venue//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const row of rows) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:venue-${row.short_id}@stuve.cloud`,
      `DTSTAMP:${icsDate(new Date())}`,
      `DTSTART:${icsDate(row.starts_at)}`,
      `DTEND:${icsDate(row.ends_at)}`,
      `SUMMARY:${escapeIcs(`Shift at ${row.venue_name}`)}`,
      `DESCRIPTION:${escapeIcs(row.note ?? "Venue shift")}`,
      `URL:${escapeIcs(`${baseUrl}/app/venue/${row.venue_short_id}`)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
};

export const venueService = {
  access: { list: listAccess, grant: grantAccess, update: changeAccess, revoke: revokeAccess, require: requirePermission },
  venues: {
    list: listVenues,
    discover: discoverVenues,
    discoverPublic: discoverPublicVenues,
    get: getVenue,
    getSummary: getVenueSummary,
    getByShortId: getVenueByShortId,
    create: createVenue,
    update: updateVenue,
    delete: deleteVenue,
  },
  venueTemplates: { list: listVenueTemplates, instantiate: instantiateVenueTemplate },
  openingRules: { list: listOpeningRules, create: createOpeningRule, update: updateOpeningRule, delete: deleteOpeningRule },
  overrides: { list: listOverrides, upsert: upsertOverride, update: updateOverride, delete: deleteOverride },
  templates: { list: listTemplates, get: getTemplate, create: createTemplate, update: updateTemplate, delete: deleteTemplate },
  shifts: { list: upcomingSlots, listSummary: upcomingSlotSummaries },
  assignments: {
    mine: listPersonalAssignments,
    getPersonal: getPersonalAssignment,
    getPersonalById: getPersonalAssignmentById,
    signupTemplate,
    signupTemplateWeeks,
    signupFree,
    cancel: cancelAssignment,
  },
  sections: { list: listSections, create: createSection, update: updateSection, delete: deleteSection },
  feedback: { create: createFeedback, summary: feedbackSummary },
  status: statusForVenue,
  publicStatus,
  dashboard,
  publicResources: { resolve: resolvePublicId, resolveOwned: resolveVenuePublicId, ...publicProjection },
  ical: { getOrCreateToken: getOrCreateIcalToken, getUserIdByToken: getUserIdByIcalToken, generateUser: generateUserIcs },
} as const;
