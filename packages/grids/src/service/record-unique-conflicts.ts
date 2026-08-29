import { err, fail, type Result } from "@k2b/stdlib";
import { isUniqueViolation } from "@valentinkolb/cloud/services";
import { getGridsCrudMessages } from "./crud-messages";
import { fieldUniqueIndexName } from "./field-indexes";
import type { Field } from "./types";

export const recordUniqueConflict = <T>(error: unknown, fields: Field[], locale?: string): Result<T> | null => {
  const messages = getGridsCrudMessages(locale);
  const field = fields.find((candidate) => candidate.uniqueConstraint && isUniqueViolation(error, fieldUniqueIndexName(candidate.id)));
  return field ? fail(err.conflict(messages.valueConflict({ field: field.name }))) : null;
};
