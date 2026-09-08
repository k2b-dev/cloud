import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { ShortIdSchema } from "../contracts";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { listByTable } from "./field-read";
import { resolvePublicIds } from "./public-resource-ids";
import type { Field } from "./types";

export {
  type PublicResourceType,
  projectPublicId,
  projectPublicIds,
  resolvePublicId,
  resolvePublicIds,
  resolveStoredPublicId,
} from "./public-resource-ids";

/** Converts relation values while retaining already-bound internal field keys. */
export const fromPublicRelationValues = async (
  fields: readonly Field[],
  values: Record<string, unknown>,
  options: { allowTemporaryRelationIds?: boolean; locale?: string } = {},
  client: SqlClient = sql,
): Promise<Result<Record<string, unknown>>> => {
  const messages = getGridsCrudMessages(options.locale);
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const relationPublicIds: string[] = [];
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fieldsById.get(fieldId);
    if (!field) return fail(err.badInput(messages.unknownPublicField));
    if (field.type !== "relation") continue;
    const ids = Array.isArray(value) ? value : value === null ? [] : [value];
    for (const id of ids) {
      if (options.allowTemporaryRelationIds && typeof id === "string" && id.startsWith("tmp_")) continue;
      const parsed = ShortIdSchema.safeParse(id);
      if (!parsed.success) return fail(err.badInput(messages.invalidRelatedRecordId));
      relationPublicIds.push(parsed.data);
    }
  }
  const relatedRecords = await resolvePublicIds("record", relationPublicIds, client);
  if (relatedRecords.size !== new Set(relationPublicIds).size) return fail(err.badInput(messages.unknownRelatedRecord));
  const internal: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    const field = fieldsById.get(fieldId)!;
    internal[field.id] =
      field.type === "relation"
        ? Array.isArray(value)
          ? value.map((id) =>
              options.allowTemporaryRelationIds && typeof id === "string" && id.startsWith("tmp_") ? id : relatedRecords.get(id as string)!,
            )
          : typeof value === "string"
            ? options.allowTemporaryRelationIds && value.startsWith("tmp_")
              ? value
              : relatedRecords.get(value)!
            : value
        : value;
  }
  return ok(internal);
};

/** Converts public field keys and relation-record IDs before domain validation. */
export const fromPublicRecordValues = async (
  tableId: string,
  values: Record<string, unknown>,
  options: { allowTemporaryRelationIds?: boolean; locale?: string } = {},
): Promise<Result<Record<string, unknown>>> => {
  const messages = getGridsCrudMessages(options.locale);
  const fields = await listByTable(tableId);
  const fieldsByPublicId = new Map(fields.map((field) => [field.shortId, field]));
  const internal: Record<string, unknown> = {};
  for (const [fieldPublicId, value] of Object.entries(values)) {
    if (!ShortIdSchema.safeParse(fieldPublicId).success) return fail(err.badInput(messages.invalidPublicFieldId));
    const field = fieldsByPublicId.get(fieldPublicId);
    if (!field) return fail(err.badInput(messages.unknownPublicField));
    internal[field.id] = value;
  }
  return fromPublicRelationValues(fields, internal, options);
};
