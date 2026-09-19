import type { FilegateError } from "@k2b/filegate";

/** Only a confirmed destination collision may offer overwrite in a client. */
export function filegateErrorCode(error: FilegateError): string {
  if (error.code === "execution_disabled") return "execution_disabled";
  if (error.code === "execution_mismatch") return "identity_changed";
  if (error.code === "feature_disabled") return "feature_disabled";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "not_found";
  if (error.status === 412) return "write_conflict";
  if (error.status === 409) {
    if (["cursor_invalid", "path_conflict", "idempotency_conflict"].includes(error.code)) return error.code;
    return "operation_conflict";
  }
  return "unavailable";
}
