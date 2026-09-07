import type { AppRegistryEntry } from "../contracts/registry";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isStringRecord = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(isString);

const invalid = (path: string, expected: string): string => `${path} must be ${expected}`;

export const validateAppRegistryEntry = (value: unknown): string | null => {
  if (!isRecord(value)) return "entry must be an object";
  for (const field of ["id", "name", "icon", "description", "baseUrl"] as const) {
    if (!isString(value[field]) || value[field].length === 0) return invalid(field, "a non-empty string");
  }
  try {
    const baseUrl = new URL(value.baseUrl as string);
    if (!(["http:", "https:"] as const).includes(baseUrl.protocol as "http:" | "https:") || baseUrl.username || baseUrl.password) {
      return invalid("baseUrl", "an HTTP(S) URL without embedded credentials");
    }
  } catch {
    return invalid("baseUrl", "an HTTP(S) URL without embedded credentials");
  }
  if (!isStringArray(value.routes) || value.routes.some((route) => !route.startsWith("/"))) {
    return invalid("routes", "an array of absolute paths");
  }
  if (value.startedAt !== undefined && !(typeof value.startedAt === "number" && Number.isFinite(value.startedAt))) {
    return invalid("startedAt", "a finite number");
  }
  if (value.runtime !== undefined) {
    if (!isRecord(value.runtime)) return invalid("runtime", "an object");
    if (!isString(value.runtime.release) || value.runtime.release.length === 0) return invalid("runtime.release", "a non-empty string");
    if (!isString(value.runtime.syncVersion) || value.runtime.syncVersion.length === 0) {
      return invalid("runtime.syncVersion", "a non-empty string");
    }
  }
  if (value.presentation !== undefined) {
    if (!isRecord(value.presentation) || !isString(value.presentation.baseLocale) || !isRecord(value.presentation.translations)) {
      return invalid("presentation", "a localized app-presentation catalog");
    }
    for (const [locale, translation] of Object.entries(value.presentation.translations)) {
      if (!isRecord(translation)) return invalid(`presentation.translations.${locale}`, "an object");
      if (translation.name !== undefined && !isString(translation.name)) return invalid(`presentation.translations.${locale}.name`, "a string");
      if (translation.description !== undefined && !isString(translation.description)) {
        return invalid(`presentation.translations.${locale}.description`, "a string");
      }
      for (const field of ["adminGroups", "adminLinks", "legalLinks"] as const) {
        if (translation[field] !== undefined && !isStringRecord(translation[field])) {
          return invalid(`presentation.translations.${locale}.${field}`, "a string map");
        }
      }
    }
  }
  if (value.nav !== undefined) {
    if (!isRecord(value.nav)) return invalid("nav", "an object");
    if (!isString(value.nav.href) || !["primary", "more", "hidden"].includes(String(value.nav.section))) {
      return invalid("nav", "a valid navigation object");
    }
    if (value.nav.requiresRoles !== undefined && !isStringArray(value.nav.requiresRoles)) {
      return invalid("nav.requiresRoles", "an array of strings");
    }
  }
  if (value.adminNav !== undefined) {
    if (
      !Array.isArray(value.adminNav) ||
      value.adminNav.some(
        (group) =>
          !isRecord(group) ||
          (group.id !== undefined && !isString(group.id)) ||
          !isString(group.label) ||
          !Array.isArray(group.links) ||
          group.links.some((link) => !isRecord(link) || !isString(link.label) || !isString(link.href) || !isString(link.icon)),
      )
    ) {
      return invalid("adminNav", "an array of valid navigation groups");
    }
  }
  if (value.legalLinks !== undefined) {
    if (
      !Array.isArray(value.legalLinks) ||
      value.legalLinks.some(
        (link) => !isRecord(link) || !isString(link.label) || !isString(link.href) || (link.icon !== undefined && !isString(link.icon)),
      )
    ) {
      return invalid("legalLinks", "an array of valid links");
    }
  }
  if (value.widgets !== undefined) {
    if (
      !Array.isArray(value.widgets) ||
      value.widgets.some((widget) => !isRecord(widget) || !isString(widget.id) || !isString(widget.path))
    ) {
      return invalid("widgets", "an array of valid widgets");
    }
  }
  if (value.settingKeys !== undefined && !isStringArray(value.settingKeys)) return invalid("settingKeys", "an array of strings");
  if (value.capabilities !== undefined) {
    if (
      !isRecord(value.capabilities) ||
      typeof value.capabilities.protocolVersion !== "number" ||
      !isString(value.capabilities.manifestHash)
    ) {
      return invalid("capabilities", "a valid capability summary");
    }
  }
  if (value.help !== undefined) {
    if (
      !isRecord(value.help) ||
      !isString(value.help.manifestHash) ||
      !isString(value.help.pageBase) ||
      !Array.isArray(value.help.documents)
    ) {
      return invalid("help", "a valid Help summary");
    }
    if (
      !value.help.pageBase.startsWith("/") ||
      value.help.documents.some(
        (document) =>
          !isRecord(document) ||
          !isString(document.id) ||
          !isString(document.title) ||
          typeof document.order !== "number" ||
          !isString(document.searchUrl) ||
          !document.searchUrl.startsWith("/") ||
          !isString(document.url) ||
          !document.url.startsWith("/"),
      )
    ) {
      return invalid("help", "a valid Help summary");
    }
  }
  if (value.openapi !== undefined && !isString(value.openapi)) return invalid("openapi", "a string");
  return null;
};

export const asAppRegistryEntry = (value: unknown): AppRegistryEntry | null =>
  validateAppRegistryEntry(value) === null ? (value as AppRegistryEntry) : null;
