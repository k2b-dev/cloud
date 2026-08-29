import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ShortIdSchema } from "../contracts";
import { getGridsCrudMessages } from "./crud-messages";
import { listByTable } from "./field-read";
import { resolvePublicIds } from "./public-resource-ids";

export {
  type PublicResourceType,
  projectPublicId,
  projectPublicIds,
  resolvePublicId,
  resolvePublicIds,
  resolveStoredPublicId,
} from "./public-resource-ids";

/** Converts public field keys and relation-record IDs before domain validation. */
export const fromPublicRecordValues = async (
  tableId: string,
  values: Record<string, unknown>,
  options: { allowTemporaryRelationIds?: boolean; locale?: string } = {},
): Promise<Result<Record<string, unknown>>> => {
  const messages = getGridsCrudMessages(options.locale);
  const fields = await listByTable(tableId);
  const fieldsByPublicId = new Map(fields.map((field) => [field.shortId, field]));
  const relationPublicIds: string[] = [];
  for (const [fieldPublicId, value] of Object.entries(values)) {
    if (!ShortIdSchema.safeParse(fieldPublicId).success) return fail(err.badInput(messages.invalidPublicFieldId));
    const field = fieldsByPublicId.get(fieldPublicId);
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
  const relatedRecords = await resolvePublicIds("record", relationPublicIds);
  if (relatedRecords.size !== new Set(relationPublicIds).size) return fail(err.badInput(messages.unknownRelatedRecord));
  const internal: Record<string, unknown> = {};
  for (const [fieldPublicId, value] of Object.entries(values)) {
    const field = fieldsByPublicId.get(fieldPublicId)!;
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
