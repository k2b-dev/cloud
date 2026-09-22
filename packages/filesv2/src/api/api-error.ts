import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { FilesError } from "../service";
import { filegateErrorCode } from "./filegate-error";

const CONFLICTS = [
  "path_conflict",
  "idempotency_conflict",
  "write_conflict",
  "cursor_invalid",
  "execution_disabled",
  "identity_changed",
  "feature_disabled",
  "operation_conflict",
];

/**
 * The code and status a thrown error answers with. Files and identity errors
 * carry their own; Filegate failures describe storage; anything else is a
 * Cloud defect (`internal`), not a storage outage, and belongs in the log.
 */
export function apiError(error: unknown): { code: string; status: number } {
  if (error instanceof FilesError || error instanceof AccountIdentityError) return { code: error.code, status: error.status };
  if (!(error instanceof FilegateError)) return { code: "internal", status: 500 };
  const code = filegateErrorCode(error);
  return { code, status: code === "forbidden" ? 403 : code === "not_found" ? 404 : CONFLICTS.includes(code) ? 409 : 503 };
}

/** Loggable view of an error and its cause chain; messages only, no stack or request bodies. */
export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof FilegateError ? { status: error.status, filegateCode: error.code } : {}),
    ...(error.cause === undefined ? {} : { cause: describeError(error.cause) }),
  };
}
