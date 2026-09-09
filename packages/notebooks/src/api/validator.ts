import { getLocale } from "@k2b/cloud/server";
import type { Context, ValidationTargets } from "hono";
import { validator as honoValidator } from "hono-openapi";
import type { ZodType } from "zod";
import { notebookApiMessages } from "./messages";

export const localizeNotebookValidationIssue = (message: string, locale: string): string => {
  const resolved = notebookApiMessages.resolve([locale]);
  return resolved.locale === "en" ? message : resolved.t.validationInvalid;
};

/** Notebook-owned validation response with request-scoped product copy. */
export const notebookV = <Target extends keyof ValidationTargets, T extends ZodType>(target: Target, schema: T) =>
  honoValidator(target, schema, (result, c: Context) => {
    if (result.success) return;
    const locale = getLocale(c);
    const { t } = notebookApiMessages.resolve([locale]);
    const message = result.error
      ?.map((issue) => {
        const path = issue.path?.map((part) => (typeof part === "object" && "key" in part ? String(part.key) : String(part))).join(".");
        const localized = localizeNotebookValidationIssue(issue.message, locale);
        return path ? `${path}: ${localized}` : localized;
      })
      .join(", ");
    return c.json({ message: message || t.validationFailed }, 400);
  });
