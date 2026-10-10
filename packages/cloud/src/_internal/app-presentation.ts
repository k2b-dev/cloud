import type { AppMeta, AppPresentationCatalog, AppPresentationTranslation, AppWidgetTranslation } from "../contracts/app";
import { WIDGET_DESCRIPTION_MAX_LENGTH, WIDGET_TITLE_MAX_LENGTH } from "../contracts/widgets";
import { canonicalLocale } from "../shared/locale";

export const APP_PRESENTATION_MAX_BYTES = 64 * 1024;
const MAX_SHORT_TEXT = 200;
const MAX_DESCRIPTION = 2_000;

const text = (value: string, label: string, max = MAX_SHORT_TEXT): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must contain 1 to ${max} characters`);
  return normalized;
};

const labels = (values: Readonly<Record<string, string>> | undefined, allowed: Set<string>, label: string, max = MAX_SHORT_TEXT) => {
  if (!values) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key ${JSON.stringify(key)}`);
    normalized[key] = text(value, `${label}.${key}`, max);
  }
  return normalized;
};

const widgetTexts = (
  values: Readonly<Record<string, AppWidgetTranslation>>,
  allowed: Set<string>,
  label: string,
): Record<string, AppWidgetTranslation> => {
  const normalized: Record<string, AppWidgetTranslation> = {};
  for (const [id, value] of Object.entries(values)) {
    if (!allowed.has(id)) throw new Error(`${label} contains unknown key ${JSON.stringify(id)}`);
    normalized[id] = {
      ...(value.title !== undefined ? { title: text(value.title, `${label}.${id}.title`, WIDGET_TITLE_MAX_LENGTH) } : {}),
      ...(value.description !== undefined
        ? { description: text(value.description, `${label}.${id}.description`, WIDGET_DESCRIPTION_MAX_LENGTH) }
        : {}),
    };
  }
  return normalized;
};

/** Validate and canonicalize one static app-presentation catalog before it enters the registry. */
export const compileAppPresentation = (app: AppMeta, catalog: AppPresentationCatalog | undefined): AppPresentationCatalog | undefined => {
  if (!catalog) return undefined;
  const baseLocale = canonicalLocale(catalog.baseLocale);
  if (!baseLocale) throw new Error("App presentation baseLocale must be a valid BCP 47 locale");

  const groupIds = new Set<string>();
  for (const group of app.adminNav ?? []) {
    if (!group.id) continue;
    if (groupIds.has(group.id)) throw new Error(`App presentation admin group id ${JSON.stringify(group.id)} is duplicated`);
    groupIds.add(group.id);
  }
  const adminHrefs = new Set((app.adminNav ?? []).flatMap((group) => group.links.map((link) => link.href)));
  const searchHrefs = new Set((app.searchLinks ?? []).map((link) => link.href));
  const legalHrefs = new Set((app.legalLinks ?? []).map((link) => link.href));
  const widgetIds = new Set((app.widgets ?? []).map((widget) => widget.id));
  const translations: Record<string, AppPresentationTranslation> = {};

  for (const [locale, translation] of Object.entries(catalog.translations)) {
    const canonical = canonicalLocale(locale);
    if (!canonical) throw new Error(`App presentation locale ${JSON.stringify(locale)} is not a valid BCP 47 locale`);
    if (canonical === baseLocale) throw new Error(`App presentation translations must not repeat base locale ${baseLocale}`);
    if (translations[canonical]) throw new Error(`App presentation locale ${canonical} is duplicated after canonicalization`);
    translations[canonical] = {
      ...(translation.name !== undefined ? { name: text(translation.name, `${canonical}.name`) } : {}),
      ...(translation.description !== undefined
        ? { description: text(translation.description, `${canonical}.description`, MAX_DESCRIPTION) }
        : {}),
      ...(translation.adminGroups ? { adminGroups: labels(translation.adminGroups, groupIds, `${canonical}.adminGroups`) } : {}),
      ...(translation.adminLinks ? { adminLinks: labels(translation.adminLinks, adminHrefs, `${canonical}.adminLinks`) } : {}),
      ...(translation.searchLinks ? { searchLinks: labels(translation.searchLinks, searchHrefs, `${canonical}.searchLinks`) } : {}),
      ...(translation.searchLinkDescriptions
        ? {
            searchLinkDescriptions: labels(
              translation.searchLinkDescriptions,
              searchHrefs,
              `${canonical}.searchLinkDescriptions`,
              MAX_DESCRIPTION,
            ),
          }
        : {}),
      ...(translation.legalLinks ? { legalLinks: labels(translation.legalLinks, legalHrefs, `${canonical}.legalLinks`) } : {}),
      ...(translation.widgets ? { widgets: widgetTexts(translation.widgets, widgetIds, `${canonical}.widgets`) } : {}),
    };
  }

  const compiled = { baseLocale, translations } satisfies AppPresentationCatalog;
  if (new TextEncoder().encode(JSON.stringify(compiled)).byteLength > APP_PRESENTATION_MAX_BYTES) {
    throw new Error(`App presentation catalog exceeds ${APP_PRESENTATION_MAX_BYTES} bytes`);
  }
  return compiled;
};
