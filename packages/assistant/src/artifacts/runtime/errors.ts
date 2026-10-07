import { ZodError } from "zod";
export type CloudErrorCode = "denied" | "not_found" | "invalid" | "conflict" | "limit" | "unavailable" | "cancelled";
export class CloudError extends Error {
  override readonly name = "CloudError";
  constructor(
    readonly code: CloudErrorCode,
    message: string,
  ) {
    super(message);
  }
}
/** The only server/host-to-runtime error mapping. Never carry vendor codes into user code. */
export function cloudError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return new CloudError(
      "invalid",
      `Invalid argument${issue?.path.length ? ` "${issue.path.join(".")}"` : ""}: ${issue?.message ?? "check the documented input shape"}.`,
    );
  }
  const value = error && typeof error === "object" ? error : {};
  const raw = "code" in value ? String(value.code) : "";
  const normalized = raw.toUpperCase();
  const status = "status" in value ? Number(value.status) : undefined;
  const name = "name" in value ? String(value.name) : "";
  const message = "message" in value ? String(value.message) : String(error);
  let code: CloudErrorCode;
  if (["denied", "not_found", "invalid", "conflict", "limit", "unavailable", "cancelled"].includes(raw)) code = raw as CloudErrorCode;
  else if (/DENIED|FORBIDDEN|PUBLIC_READ_ONLY/.test(normalized)) code = "denied";
  else if (/NOT_FOUND|UNKNOWN_TABLE|UNKNOWN_COLUMN|HTTP_SECRET/.test(normalized)) code = "not_found";
  else if (/CONFLICT|UNIQUE|DUPLICATE/.test(normalized)) code = "conflict";
  else if (/LIMIT|TOO_LARGE|STORAGE_FULL|TOO_MANY|BUDGET/.test(normalized) || /exceed|budget|too many/i.test(message)) code = "limit";
  else if (/CANCEL/.test(normalized) || name === "AbortError") code = "cancelled";
  else if (normalized === "DB_NOT_CONFIGURED") code = "unavailable";
  else if (/INVALID|SQL_UNSUPPORTED|SQL_PARAMS|NOT_NULL/.test(normalized) || ["ZodError", "TypeError", "RangeError"].includes(name))
    code = "invalid";
  else if (status === 401 || status === 403) code = "denied";
  else if (status === 404) code = "not_found";
  else if (status === 409) code = "conflict";
  else if (status === 413 || status === 429) code = "limit";
  else if (status === 400 || status === 422) code = "invalid";
  else code = "unavailable";
  return new CloudError(code, message.replace(/[\r\n]+/g, " ").slice(0, 16000));
}
/** Normalize synchronous helpers and asynchronous bridge/chunk calls at the public surface. */
export function guarded<T extends (...args: never[]) => unknown>(fn: T): T;
export function guarded(fn: Function): Function;
export function guarded(fn: Function): Function {
  return function (this: unknown, ...args: unknown[]) {
    try {
      const result = fn.apply(this, args);
      return result instanceof Promise
        ? result.catch((error) => {
            throw cloudError(error);
          })
        : result;
    } catch (error) {
      throw cloudError(error);
    }
  };
}
