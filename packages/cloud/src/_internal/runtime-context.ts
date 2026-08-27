import type { CloudRuntime, RuntimeAppMeta } from "../contracts/app";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import type { Role } from "../contracts/shared";

/**
 * Builds a `CloudRuntime` (the shape consumed by Layout, AdminSidebar, NavMenu)
 * from registry entries.
 *
 * This produces the exact same shape as `createRuntimeContext()` in core/runtime.ts,
 * so all existing UI components work unchanged.
 */
export const buildRuntimeFromRegistry = (entries: AppRegistryEntry[], capabilities: CapabilityRegistryEntry[] = []): CloudRuntime => ({
  apps: entries.map((e): RuntimeAppMeta => {
    const searchQueries = capabilities.find((entry) => entry.appId === e.id)?.manifest.queries.filter((query) => query.universalSearch);
    const searchTags = searchQueries?.flatMap((query) => query.universalSearch!.tags.flatMap((tag) => [tag.tag, ...(tag.aliases ?? [])]));
    return {
      id: e.id,
      name: e.name,
      icon: e.icon,
      description: e.description,
      presentation: e.presentation
        ? {
            baseLocale: e.presentation.baseLocale,
            translations: Object.fromEntries(
              Object.entries(e.presentation.translations).map(([locale, translation]) => [
                locale,
                {
                  ...translation,
                  adminGroups: translation.adminGroups ? { ...translation.adminGroups } : undefined,
                  adminLinks: translation.adminLinks ? { ...translation.adminLinks } : undefined,
                  legalLinks: translation.legalLinks ? { ...translation.legalLinks } : undefined,
                },
              ]),
            ),
          }
        : undefined,
      appearance: e.appearance,
      adminHref: e.nav?.adminHref,
      adminNav: e.adminNav?.map((group) => ({
        id: group.id,
        label: group.label,
        links: group.links.map((link) => ({ ...link })),
      })),
      routes: e.routes,
      nav: e.nav
        ? {
            href: e.nav.href,
            match: e.nav.match,
            section: e.nav.section,
            requiresAuth: e.nav.requiresAuth,
            // Registry stores roles as serialized strings; the source type is
            // Role[] and round-trip is value-preserving.
            requiresRoles: e.nav.requiresRoles as Role[] | undefined,
          }
        : undefined,
      help: e.help
        ? {
            manifestHash: e.help.manifestHash,
            pageBase: e.help.pageBase,
            baseLocale: e.help.baseLocale,
            documentsByLocale: e.help.documentsByLocale
              ? Object.fromEntries(
                  Object.entries(e.help.documentsByLocale).map(([locale, documents]) => [
                    locale,
                    documents.map((document) => ({ ...document })),
                  ]),
                )
              : undefined,
            documents: e.help.documents.map((document) => ({ ...document })),
          }
        : undefined,
      searchTags,
      searchHelp: searchQueries?.map((query) => query.description).join(" "),
      searchTagHelp: searchQueries?.flatMap((query) =>
        query.universalSearch!.tags.flatMap((tag) => [
          { tag: tag.tag, help: tag.description },
          ...(tag.aliases ?? []).map((alias) => ({ tag: alias, help: `${tag.description} (alias of #${tag.tag})` })),
        ]),
      ),
      legalLinks: e.legalLinks ? e.legalLinks.map((l) => ({ ...l })) : undefined,
      openapi: e.openapi,
    };
  }),
});
