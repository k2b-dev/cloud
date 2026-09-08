import { err, fail, ok, type Result } from "@k2b/stdlib";
import { isUniqueViolation } from "@valentinkolb/cloud/services";

export const namedResourceConflict = <T>(error: unknown, constraintName: string, message: string): Result<T> | null =>
  isUniqueViolation(error, constraintName) ? fail(err.conflict(message)) : null;

export const writeNamedResource = async <T>(write: () => Promise<T>, constraintName: string, message: string): Promise<Result<T>> => {
  try {
    return ok(await write());
  } catch (error) {
    const conflict = namedResourceConflict<T>(error, constraintName, message);
    if (conflict) return conflict;
    throw error;
  }
};
