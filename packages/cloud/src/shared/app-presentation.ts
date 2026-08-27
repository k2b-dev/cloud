import type { AppMeta, AppPresentationCatalog, AppPresentationTranslation } from "../contracts/app";
import { canonicalLocale, localeFallbackChain, normalizeLocale } from "./locale";

const mergedTranslation = (catalog: AppPresentationCatalog, requestedLocale: string): AppPresentationTranslation => {
  const baseLocale = normalizeLocale(catalog.baseLocale);
  const byLocale = new Map(
    Object.entries(catalog.translations).flatMap(([locale, translation]) => {
      const canonical = canonicalLocale(locale);
      return canonical ? [[canonical, translation] as const] : [];
    }),
  );
  const overlays = localeFallbackChain(requestedLocale, baseLocale).filter((locale) => locale !== baseLocale).reverse();
  return overlays.reduce<AppPresentationTranslation>(
    (current, locale) => {
      const next = byLocale.get(locale);
      if (!next) return current;
      return {
        ...current,
        ...next,
        adminGroups: { ...current.adminGroups, ...next.adminGroups },
        adminLinks: { ...current.adminLinks, ...next.adminLinks },
        legalLinks: { ...current.legalLinks, ...next.legalLinks },
      };
    },
    {},
  );
};

/** Resolve only human presentation; stable app identity, routes, icons, and authorization stay untouched. */
export const resolveAppPresentation = <T extends AppMeta>(app: T, requestedLocale: string): T => {
  if (!app.presentation) return app;
  const translation = mergedTranslation(app.presentation, requestedLocale);
  if (Object.keys(translation).length === 0) return app;
  return {
    ...app,
    name: translation.name ?? app.name,
    description: translation.description ?? app.description,
    adminNav: app.adminNav?.map((group) => ({
      ...group,
      label: (group.id && translation.adminGroups?.[group.id]) || group.label,
      links: group.links.map((link) => ({ ...link, label: translation.adminLinks?.[link.href] ?? link.label })),
    })),
    legalLinks: app.legalLinks?.map((link) => ({ ...link, label: translation.legalLinks?.[link.href] ?? link.label })),
  };
};

export const resolveAppPresentations = <T extends AppMeta>(apps: readonly T[], requestedLocale: string): T[] =>
  apps.map((app) => resolveAppPresentation(app, requestedLocale));
