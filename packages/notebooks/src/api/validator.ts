import { getLocale } from "@valentinkolb/cloud/server";
import type { Context, ValidationTargets } from "hono";
import { validator as honoValidator } from "hono-openapi";
import type { ZodType } from "zod";
import { notebookApiMessages } from "./messages";

export const localizeNotebookValidationIssue = (message: string, locale: string): string => {
  const { t } = notebookApiMessages.resolve([locale]);
  if (!locale.toLowerCase().startsWith("de")) return message;
  if (/received undefined|received null|expected .*[, ] received undefined/iu.test(message)) return t.validationRequired;
  if (/too small|minimum|>=/iu.test(message)) return t.validationTooSmall;
  if (/too big|maximum|<=/iu.test(message)) return t.validationTooBig;
  if (/expected string/iu.test(message)) return t.validationString;
  if (/expected number|expected int/iu.test(message)) return t.validationNumber;
  if (/expected boolean/iu.test(message)) return t.validationBoolean;
  if (/expected array/iu.test(message)) return t.validationArray;
  if (/expected object/iu.test(message)) return t.validationObject;
  if (/invalid format|invalid uuid|invalid datetime|invalid date|invalid url/iu.test(message)) return t.validationInvalidFormat;
  return t.validationInvalid;
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
