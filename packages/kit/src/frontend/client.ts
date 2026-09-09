import { hc } from "hono/client";
import type { ApiType } from "../api";
import { apiErrorMessage, ProjectValidationError } from "../errors";
export const client = hc<ApiType>("/api/kit");
export class KitRequestError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
export function displayError(error: unknown, locale: string): string {
  if (error instanceof ProjectValidationError) return error.localized(locale);
  if (error instanceof KitRequestError) return error.message;
  return apiErrorMessage("REQUEST_FAILED", locale);
}
export async function checked<T>(response: Response & { json: () => Promise<T> }): Promise<T> {
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => null);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "REQUEST_FAILED";
    const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
    const locale = typeof document === "undefined" ? "en" : document.documentElement.lang;
    throw new KitRequestError(code, message && message !== code ? message : apiErrorMessage(code, locale), response.status);
  }
  return response.json();
}
