import { isUniqueViolation, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { dates } from "@k2b/stdlib";
import { sql } from "bun";
import {
  type CreateItemTemplate,
  type ItemTemplateKind,
  itemTemplateKindMismatch,
  MAX_ITEM_TEMPLATES_PER_KIND,
  type MutationResult,
  type SpaceItemAssignee,
  type SpaceItemTemplate,
  type SpaceTag,
  type TemplateDateRule,
  type TemplateWeekday,
  type UpdateItemTemplate,
} from "@/contracts";
import { withShortId } from "../lib/short-id";
import { defaultTemplateDate, draftFromTemplate, proposeTemplateDates, type TemplateItemDraft } from "../presentation/item-templates";
import { filterAssigneeIdsWithAccess, validateAssigneeIdsInSpace, validateTagIdsInSpace } from "./items";

// ==========================
// Item templates: per-Space defaults for new tasks and events. IDs here are internal UUIDs;
// the API and capabilities project them.
// ==========================

type SqlExecutor = typeof sql;

type DbTemplate = {
  id: string;
  space_id: string;
  kind: ItemTemplateKind;
  name: string;
  title: string;
  description: string | null;
  priority: SpaceItemTemplate["priority"];
  assign_creator: boolean;
  checklist: string[];
  estimated_duration_minutes: number | null;
  location: string | null;
  url: string | null;
  all_day: boolean;
  duration_minutes: number | null;
  time_of_day: string | null;
  date_rule: TemplateDateRule["type"];
  date_weekdays: TemplateWeekday[];
  date_offset_days: number | null;
  created_at: Date;
  updated_at: Date;
};

const NAME_TAKEN = "A template with this name already exists";
const LIMIT_REACHED = "This Space already has the maximum number of templates of this kind";
const NAME_INDEX = "idx_item_templates_space_kind_name";

const dateRuleOf = (row: DbTemplate): TemplateDateRule =>
  row.date_rule === "weekdays"
    ? { type: "weekdays", weekdays: row.date_weekdays }
    : row.date_rule === "offset"
      ? { type: "offset", days: row.date_offset_days ?? 0 }
      : { type: "none" };

const mapTemplate = (row: DbTemplate, tags: SpaceTag[], assignees: SpaceItemAssignee[]): SpaceItemTemplate => ({
  id: row.id,
  spaceId: row.space_id,
  kind: row.kind,
  name: row.name,
  title: row.title,
  description: row.description,
  priority: row.priority,
  tags,
  assignees,
  assignCreator: row.assign_creator,
  checklist: row.checklist,
  estimatedDurationMinutes: row.estimated_duration_minutes,
  location: row.location,
  url: row.url,
  allDay: row.all_day,
  durationMinutes: row.duration_minutes,
  // Postgres TIME reads as HH:MM:SS.
  timeOfDay: row.time_of_day ? row.time_of_day.slice(0, 5) : null,
  dateRule: dateRuleOf(row),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const loadRelations = async (rows: DbTemplate[]): Promise<SpaceItemTemplate[]> => {
  if (rows.length === 0) return [];
  const ids = toPgUuidArray(rows.map((row) => row.id));
  const [tagRows, assigneeRows] = await Promise.all([
    sql<{ template_id: string; id: string; space_id: string; name: string; color: string }[]>`
      SELECT tt.template_id, t.id, t.space_id, t.name, t.color
      FROM spaces.item_template_tags tt
      JOIN spaces.tags t ON t.id = tt.tag_id
      WHERE tt.template_id = ANY(${ids}::uuid[])
      ORDER BY t.name
    `,
    sql<{ template_id: string; id: string; display_name: string; avatar_hash: string | null }[]>`
      SELECT ta.template_id, u.id, u.display_name, u.avatar_hash
      FROM spaces.item_template_assignees ta
      JOIN auth.users u ON u.id = ta.user_id
      WHERE ta.template_id = ANY(${ids}::uuid[])
      ORDER BY u.display_name
    `,
  ]);
  // A default assignee counts only while they can access the Space, so the form, the API, capabilities, and new
  // items all see the same people; the stored choice returns with the access.
  const withAccess = new Map<string, Set<string>>();
  for (const spaceId of new Set(rows.map((row) => row.space_id))) {
    const templateIds = new Set(rows.filter((row) => row.space_id === spaceId).map((row) => row.id));
    const userIds = assigneeRows.filter((row) => templateIds.has(row.template_id)).map((row) => row.id);
    withAccess.set(spaceId, new Set(await filterAssigneeIdsWithAccess(spaceId, userIds)));
  }
  const tags = Map.groupBy(tagRows, (row) => row.template_id);
  const assignees = Map.groupBy(assigneeRows, (row) => row.template_id);
  return rows.map((row) =>
    mapTemplate(
      row,
      (tags.get(row.id) ?? []).map((tag) => ({ id: tag.id, spaceId: tag.space_id, name: tag.name, color: tag.color })),
      (assignees.get(row.id) ?? [])
        .filter((user) => withAccess.get(row.space_id)?.has(user.id))
        .map((user) => ({ id: user.id, displayName: user.display_name, avatarHash: user.avatar_hash })),
    ),
  );
};

const COLUMNS = sql`
  id, space_id, kind, name, title, description, priority, assign_creator, checklist, estimated_duration_minutes,
  location, url, all_day, duration_minutes, time_of_day::text AS time_of_day, date_rule, date_weekdays, date_offset_days,
  created_at, updated_at
`;

/** Templates of a Space, by kind and then name. */
export const list = async (params: { spaceId: string; kind?: ItemTemplateKind }): Promise<SpaceItemTemplate[]> => {
  const rows = await sql<DbTemplate[]>`
    SELECT ${COLUMNS}
    FROM spaces.item_templates
    WHERE space_id = ${params.spaceId}::uuid AND (${params.kind ?? null}::text IS NULL OR kind = ${params.kind ?? null})
    ORDER BY kind DESC, lower(name), id
    LIMIT ${MAX_ITEM_TEMPLATES_PER_KIND * 2}
  `;
  return loadRelations(rows);
};

export const get = async (params: { id: string }): Promise<SpaceItemTemplate | null> => {
  const rows = await sql<DbTemplate[]>`SELECT ${COLUMNS} FROM spaces.item_templates WHERE id = ${params.id}::uuid`;
  const [template] = await loadRelations(rows);
  return template ?? null;
};

/** A template of the Space whose name matches case-insensitively; the name is unique per Space and kind. */
export const findByName = async (params: { spaceId: string; name: string; kind?: ItemTemplateKind }): Promise<SpaceItemTemplate[]> => {
  const rows = await sql<DbTemplate[]>`
    SELECT ${COLUMNS}
    FROM spaces.item_templates
    WHERE space_id = ${params.spaceId}::uuid
      AND lower(name) = lower(${params.name.trim()})
      AND (${params.kind ?? null}::text IS NULL OR kind = ${params.kind ?? null})
    ORDER BY kind DESC
  `;
  return loadRelations(rows);
};

type TemplateValues = Omit<CreateItemTemplate, "kind" | "tagIds" | "assigneeIds">;

/** An empty location means none, as a task template requires. */
const blankToNull = (value: string | null | undefined): string | null => (value?.trim() ? value : null);

const dateRuleColumns = (rule: TemplateDateRule) => ({
  date_rule: rule.type,
  date_weekdays: rule.type === "weekdays" ? [...new Set(rule.weekdays)] : [],
  date_offset_days: rule.type === "offset" ? rule.days : null,
});

const replaceRelations = async (db: SqlExecutor, templateId: string, data: { tagIds?: string[]; assigneeIds?: string[] }) => {
  if (data.tagIds !== undefined) {
    await db`DELETE FROM spaces.item_template_tags WHERE template_id = ${templateId}::uuid`;
    const tagIds = [...new Set(data.tagIds)];
    if (tagIds.length > 0) {
      await db`
        INSERT INTO spaces.item_template_tags (template_id, tag_id)
        SELECT ${templateId}::uuid, tag_id FROM unnest(${toPgUuidArray(tagIds)}::uuid[]) AS tag_id
      `;
    }
  }
  if (data.assigneeIds !== undefined) {
    await db`DELETE FROM spaces.item_template_assignees WHERE template_id = ${templateId}::uuid`;
    const userIds = [...new Set(data.assigneeIds)];
    if (userIds.length > 0) {
      await db`
        INSERT INTO spaces.item_template_assignees (template_id, user_id)
        SELECT ${templateId}::uuid, user_id FROM unnest(${toPgUuidArray(userIds)}::uuid[]) AS user_id
      `;
    }
  }
};

const validateRelations = async (spaceId: string, data: { tagIds?: string[]; assigneeIds?: string[] }): Promise<MutationResult<void>> => {
  const tags = await validateTagIdsInSpace(spaceId, data.tagIds);
  if (!tags.ok) return tags;
  return validateAssigneeIdsInSpace(spaceId, data.assigneeIds);
};

export const create = async (params: {
  spaceId: string;
  data: CreateItemTemplate;
  createdBy: string | null;
}): Promise<MutationResult<SpaceItemTemplate>> => {
  const { spaceId, data } = params;
  const relations = await validateRelations(spaceId, data);
  if (!relations.ok) return relations;
  const rule = dateRuleColumns(data.dateRule);
  try {
    const created = await withShortId("template", (shortId) =>
      sql.begin(async (tx): Promise<MutationResult<string>> => {
        // One lock per Space serializes creates, so the bound below cannot be overrun by parallel requests.
        await tx`SELECT id FROM spaces.spaces WHERE id = ${spaceId}::uuid FOR UPDATE`;
        const [count] = await tx<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM spaces.item_templates WHERE space_id = ${spaceId}::uuid AND kind = ${data.kind}
        `;
        if ((count?.count ?? 0) >= MAX_ITEM_TEMPLATES_PER_KIND) return { ok: false, error: LIMIT_REACHED, status: 409 };
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO spaces.item_templates (
            short_id, space_id, kind, name, title, description, priority, assign_creator, checklist,
            estimated_duration_minutes, location, url, all_day, duration_minutes, time_of_day,
            date_rule, date_weekdays, date_offset_days, created_by
          ) VALUES (
            ${shortId}, ${spaceId}::uuid, ${data.kind}, ${data.name.trim()}, ${data.title}, ${data.description ?? null},
            ${data.priority ?? null}, ${data.assignCreator}, ${toPgTextArray(data.checklist ?? [])}::text[],
            ${data.estimatedDurationMinutes ?? null}, ${blankToNull(data.location)}, ${data.url ?? null}, ${data.allDay},
            ${data.durationMinutes ?? null}, ${data.timeOfDay ?? null}::time, ${rule.date_rule},
            ${toPgTextArray(rule.date_weekdays)}::text[], ${rule.date_offset_days}, ${params.createdBy}::uuid
          )
          RETURNING id
        `;
        if (!row) return { ok: false, error: "Failed to create template", status: 500 };
        await replaceRelations(tx, row.id, data);
        return { ok: true, data: row.id };
      }),
    );
    if (!created.ok) return created;
    const template = await get({ id: created.data });
    return template ? { ok: true, data: template } : { ok: false, error: "Failed to load template", status: 500 };
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return { ok: false, error: NAME_TAKEN, status: 409 };
    throw error;
  }
};

export const update = async (params: { id: string; data: UpdateItemTemplate }): Promise<MutationResult<SpaceItemTemplate>> => {
  const existing = await get({ id: params.id });
  if (!existing) return { ok: false, error: "Template not found", status: 404 };
  const { data } = params;
  const merged: TemplateValues = {
    name: data.name ?? existing.name,
    title: data.title ?? existing.title,
    description: data.description === undefined ? existing.description : data.description,
    priority: data.priority === undefined ? existing.priority : data.priority,
    assignCreator: data.assignCreator ?? existing.assignCreator,
    checklist: data.checklist ?? existing.checklist,
    estimatedDurationMinutes:
      data.estimatedDurationMinutes === undefined ? existing.estimatedDurationMinutes : data.estimatedDurationMinutes,
    location: data.location === undefined ? existing.location : data.location,
    url: data.url === undefined ? existing.url : data.url,
    allDay: data.allDay ?? existing.allDay,
    durationMinutes: data.durationMinutes === undefined ? existing.durationMinutes : data.durationMinutes,
    timeOfDay: data.timeOfDay === undefined ? existing.timeOfDay : data.timeOfDay,
    dateRule: data.dateRule ?? existing.dateRule,
  };
  const mismatch = itemTemplateKindMismatch(existing.kind, merged);
  if (mismatch) return { ok: false, error: `${mismatch} is not available for ${existing.kind} templates`, status: 400 };
  const relations = await validateRelations(existing.spaceId, data);
  if (!relations.ok) return relations;
  const rule = dateRuleColumns(merged.dateRule);
  try {
    const updated = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        UPDATE spaces.item_templates SET
          name = ${merged.name.trim()},
          title = ${merged.title},
          description = ${merged.description ?? null},
          priority = ${merged.priority ?? null},
          assign_creator = ${merged.assignCreator},
          checklist = ${toPgTextArray(merged.checklist ?? [])}::text[],
          estimated_duration_minutes = ${merged.estimatedDurationMinutes ?? null},
          location = ${blankToNull(merged.location)},
          url = ${merged.url ?? null},
          all_day = ${merged.allDay},
          duration_minutes = ${merged.durationMinutes ?? null},
          time_of_day = ${merged.timeOfDay ?? null}::time,
          date_rule = ${rule.date_rule},
          date_weekdays = ${toPgTextArray(rule.date_weekdays)}::text[],
          date_offset_days = ${rule.date_offset_days},
          updated_at = now()
        WHERE id = ${params.id}::uuid
        RETURNING id
      `;
      if (row) await replaceRelations(tx, row.id, data);
      return Boolean(row);
    });
    if (!updated) return { ok: false, error: "Template not found", status: 404 };
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return { ok: false, error: NAME_TAKEN, status: 409 };
    throw error;
  }
  const template = await get({ id: params.id });
  return template ? { ok: true, data: template } : { ok: false, error: "Template not found", status: 404 };
};

export const remove = async (params: { id: string }): Promise<MutationResult<void>> => {
  const result = await sql`DELETE FROM spaces.item_templates WHERE id = ${params.id}::uuid`;
  return result.count === 0 ? { ok: false, error: "Template not found", status: 404 } : { ok: true, data: undefined };
};

export type TemplateDraftResult = { proposals: string[]; date: string | null; timeZone: string; item: TemplateItemDraft };

/**
 * A new item filled from `template` for `date`, or for its first proposal when none is given. `template` may carry
 * public or internal tag IDs; the draft keeps whichever it gets. Only an explicit `noDate` leaves a task without a
 * due date, and an event always needs one.
 */
export const draft = async (params: {
  template: SpaceItemTemplate;
  date?: string;
  noDate?: boolean;
  timeZone: string;
  locale?: string;
  now?: Date;
}): Promise<MutationResult<TemplateDraftResult>> => {
  const { template } = params;
  if (!dates.isValidTimeZone(params.timeZone)) return { ok: false, error: "Unknown time zone", status: 400 };
  if (params.noDate && params.date) return { ok: false, error: "Pass either a date or no date, not both", status: 400 };
  if (params.noDate && template.kind === "event") return { ok: false, error: "An event needs a date", status: 400 };
  const now = params.now ?? new Date();
  const proposals = proposeTemplateDates(template, { now, timeZone: params.timeZone });
  const date = params.noDate ? null : (params.date ?? defaultTemplateDate(template, { now, timeZone: params.timeZone }));
  const item = draftFromTemplate(
    {
      ...template,
      tagIds: template.tags.map((tag) => tag.id),
      assigneeIds: template.assignees.map((assignee) => assignee.id),
    },
    { date, timeZone: params.timeZone, locale: params.locale, now },
  );
  return { ok: true, data: { proposals, date, timeZone: params.timeZone, item } };
};
