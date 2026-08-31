import { err, fail, ok, type PageParams, type Paginated, paginate } from "@k2b/stdlib";
import { logger, toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { normalizeFaqTranslations, resolveFaqEntry } from "@/content";
import { type CreateFaq, type FaqEntry, FaqTranslationsSchema, type UpdateFaq } from "@/contracts";
import { faqServiceMessages } from "./messages";

const log = logger("faq");

type DbRow = {
  id: string;
  translations: unknown;
  audience: string[];
  position: number;
  created_at: string | Date;
};

type ListConfig = {
  pagination?: PageParams;
  filter?: {
    audience?: string;
    query?: string;
  };
};

/**
 * Converts one `faq.entries` row into the API-facing `FaqEntry` shape.
 */
const mapRow = (row: DbRow): FaqEntry => ({
  id: row.id,
  translations: FaqTranslationsSchema.parse(row.translations),
  audience: row.audience as FaqEntry["audience"],
  position: row.position,
  createdAt: new Date(row.created_at).toISOString(),
});

const paginateItems = <T>(items: T[], pagination?: PageParams): Paginated<T> => {
  if (!pagination) {
    return {
      items,
      page: 1,
      perPage: items.length,
      total: items.length,
      hasNext: false,
    };
  }

  const { page, perPage, offset } = paginate(pagination);
  const sliced = items.slice(offset, offset + perPage);
  return {
    items: sliced,
    page,
    perPage,
    total: items.length,
    hasNext: page * perPage < items.length,
  };
};

const matchesQuery = (entry: FaqEntry, query: string): boolean => {
  const normalized = query.toLowerCase();
  return Object.values(entry.translations).some(
    (translation) => translation.question.toLowerCase().includes(normalized) || translation.answer.toLowerCase().includes(normalized),
  );
};

/**
 * Lists FAQ entries ordered by position with optional text search and pagination.
 */
const list = async (config: ListConfig = {}) => {
  const audience = config?.filter?.audience;
  const rows = audience
    ? await sql`
        SELECT * FROM faq.entries
        WHERE ${audience} = ANY(audience)
        ORDER BY position ASC, created_at ASC
      `
    : await sql`
        SELECT * FROM faq.entries
        ORDER BY position ASC, created_at ASC
      `;

  const entries = (rows as DbRow[]).map(mapRow);
  const query = config?.filter?.query?.trim().toLowerCase();
  const filtered = query ? entries.filter((entry) => matchesQuery(entry, query)) : entries;

  return paginateItems(filtered, config?.pagination);
};

const listResolved = async (config: ListConfig & { locale?: string | null } = {}) => {
  const page = await list(config);
  return { ...page, items: page.items.map((entry) => resolveFaqEntry(entry, config.locale)) };
};

/**
 * Returns one FAQ entry by UUID, or `null` when it does not exist.
 */
const get = async (config: { id: string }) => {
  const [row] = await sql`
    SELECT * FROM faq.entries
    WHERE id = ${config.id}::uuid
  `;
  return row ? mapRow(row as DbRow) : null;
};

/**
 * Creates a new FAQ entry and appends it to the current tail position.
 */
const create = async (config: { data: CreateFaq; locale?: string | null }) => {
  const t = faqServiceMessages(config.locale);
  try {
    const [maxRow] = await sql`SELECT COALESCE(MAX(position), -1) AS max_pos FROM faq.entries`;
    const nextPos = (maxRow as { max_pos: number }).max_pos + 1;

    const translations = normalizeFaqTranslations(config.data.translations);
    const [row] = await sql`
      INSERT INTO faq.entries (translations, audience, position)
      VALUES ((${JSON.stringify(translations)}::text)::jsonb, ${toPgTextArray(config.data.audience)}::text[], ${nextPos})
      RETURNING *
    `;

    return ok(mapRow(row as DbRow));
  } catch (error) {
    log.error("Failed to create FAQ", { error: (error as Error).message });
    return fail(err.internal(t.createFailed));
  }
};

/**
 * Updates one FAQ entry in-place and keeps existing values for omitted fields.
 */
const update = async (config: { id: string; data: UpdateFaq; locale?: string | null }) => {
  const t = faqServiceMessages(config.locale);
  try {
    const [existing] = await sql`SELECT id FROM faq.entries WHERE id = ${config.id}::uuid`;
    if (!existing) return fail({ code: "NOT_FOUND", status: 404, message: t.notFound });

    const audienceLiteral = config.data.audience ? toPgTextArray(config.data.audience) : null;
    const translations = config.data.translations ? JSON.stringify(normalizeFaqTranslations(config.data.translations)) : null;

    const [row] = await sql`
      UPDATE faq.entries SET
        translations = COALESCE((${translations}::text)::jsonb, translations),
        audience = COALESCE(${audienceLiteral}::text[], audience)
      WHERE id = ${config.id}::uuid
      RETURNING *
    `;

    return ok(mapRow(row as DbRow));
  } catch (error) {
    log.error("Failed to update FAQ", {
      error: (error as Error).message,
      id: config.id,
    });
    return fail(err.internal(t.updateFailed));
  }
};

/**
 * Deletes one FAQ entry and returns `NOT_FOUND` if the UUID is unknown.
 */
const remove = async (config: { id: string; locale?: string | null }) => {
  const t = faqServiceMessages(config.locale);
  try {
    const [existing] = await sql`SELECT id FROM faq.entries WHERE id = ${config.id}::uuid`;
    if (!existing) return fail({ code: "NOT_FOUND", status: 404, message: t.notFound });

    await sql`DELETE FROM faq.entries WHERE id = ${config.id}::uuid`;
    return ok();
  } catch (error) {
    log.error("Failed to delete FAQ", {
      error: (error as Error).message,
      id: config.id,
    });
    return fail(err.internal(t.deleteFailed));
  }
};

/**
 * Rewrites FAQ positions in the provided order (index becomes persisted `position`).
 */
const reorder = async (config: { ids: string[]; locale?: string | null }) => {
  const t = faqServiceMessages(config.locale);
  try {
    if (config.ids.length === 0) return ok();

    const uniqueIds = new Set(config.ids);
    if (uniqueIds.size !== config.ids.length) return fail(err.badInput(t.duplicateIds));

    const existingRows = await sql<{ id: string }[]>`
      SELECT id
      FROM faq.entries
      WHERE id = ANY(${toPgUuidArray(config.ids)}::uuid[])
    `;
    if (existingRows.length !== uniqueIds.size) return fail({ code: "NOT_FOUND", status: 404, message: t.notFound });

    await sql.begin(async (tx) => {
      for (const [index, id] of config.ids.entries()) {
        await tx`UPDATE faq.entries SET position = ${index} WHERE id = ${id}::uuid`;
      }
    });
    return ok();
  } catch (error) {
    log.error("Failed to reorder FAQs", { error: (error as Error).message });
    return fail(err.internal(t.reorderFailed));
  }
};

export const faqService = {
  entry: {
    list,
    listResolved,
    get,
    create,
    update,
    remove,
    reorder,
  },
};

export type FaqService = typeof faqService;
