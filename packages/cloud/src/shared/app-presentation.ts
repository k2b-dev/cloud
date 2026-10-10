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
  const overlays = localeFallbackChain(requestedLocale, baseLocale)
    .filter((locale) => locale !== baseLocale)
    .reverse();
  return overlays.reduce<AppPresentationTranslation>((current, locale) => {
    const next = byLocale.get(locale);
    if (!next) return current;
    return {
      ...current,
      ...next,
      adminGroups: { ...current.adminGroups, ...next.adminGroups },
      adminLinks: { ...current.adminLinks, ...next.adminLinks },
      legalLinks: { ...current.legalLinks, ...next.legalLinks },
      searchLinks: { ...current.searchLinks, ...next.searchLinks },
      searchLinkDescriptions: { ...current.searchLinkDescriptions, ...next.searchLinkDescriptions },
      widgets: Object.fromEntries(
        [...new Set([...Object.keys(current.widgets ?? {}), ...Object.keys(next.widgets ?? {})])].map((id) => [
          id,
          { ...current.widgets?.[id], ...next.widgets?.[id] },
        ]),
      ),
    };
  }, {});
};

/** Resolve only an app's display name and description, for consumers that carry no other app metadata. */
export const resolveAppIdentityPresentation = (
  app: { name: string; description: string; presentation?: AppPresentationCatalog },
  requestedLocale: string,
): { name: string; description: string } => {
  const translation = app.presentation ? mergedTranslation(app.presentation, requestedLocale) : {};
  return { name: translation.name ?? app.name, description: translation.description ?? app.description };
};

/** Resolve only human presentation; stable app identity, routes, icons, and authorization stay untouched. */
export const resolveAppPresentation = <T extends AppMeta>(app: T, requestedLocale: string): T => {
  if (!app.presentation) return app;
  const translation = mergedTranslation(app.presentation, requestedLocale);
  if (Object.keys(translation).length === 0) return app;
  return {
    ...app,
    ...resolveAppIdentityPresentation(app, requestedLocale),
    adminNav: app.adminNav?.map((group) => ({
      ...group,
      label: (group.id && translation.adminGroups?.[group.id]) || group.label,
      links: group.links.map((link) => ({ ...link, label: translation.adminLinks?.[link.href] ?? link.label })),
    })),
    searchLinks: app.searchLinks?.map((link) => ({
      ...link,
      label: translation.searchLinks?.[link.href] ?? link.label,
      description: translation.searchLinkDescriptions?.[link.href] ?? link.description,
    })),
    legalLinks: app.legalLinks?.map((link) => ({ ...link, label: translation.legalLinks?.[link.href] ?? link.label })),
    widgets: app.widgets?.map((widget) => ({
      ...widget,
      title: translation.widgets?.[widget.id]?.title ?? widget.title,
      description: translation.widgets?.[widget.id]?.description ?? widget.description,
    })),
  };
};

export const resolveAppPresentations = <T extends AppMeta>(apps: readonly T[], requestedLocale: string): T[] =>
  apps.map((app) => resolveAppPresentation(app, requestedLocale));
