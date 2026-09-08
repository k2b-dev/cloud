import type { FibelHeaderConfig, FibelThemeConfig, LocaleConfig, NavLink } from "@k2b/fibel";

const configuredSiteUrl = process.env.CLOUD_DOCS_SITE_URL?.trim().replace(/\/+$/, "");

if (process.env.NODE_ENV === "production" && !configuredSiteUrl) {
  throw new Error("CLOUD_DOCS_SITE_URL is required in production.");
}

export const siteUrl = configuredSiteUrl
  ? (() => {
      let url: URL;
      try {
        url = new URL(configuredSiteUrl);
      } catch {
        throw new Error("CLOUD_DOCS_SITE_URL must be an absolute HTTP(S) origin without a path.");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
        throw new Error("CLOUD_DOCS_SITE_URL must be an absolute HTTP(S) origin without a path.");
      }
      return url.origin;
    })()
  : undefined;

export const siteLocales = [{ code: "en", label: "English" }] satisfies LocaleConfig[];

export const siteTheme = {
  defaultMode: "light",
  cookieName: "cloud_docs_theme",
} satisfies FibelThemeConfig;

export const siteHeader = {
  title: "Cloud",
  homeHref: "/en",
  searchLabel: "Search",
  links: [
    {
      label: "Apps",
      href: ({ locale }) => `/${locale}/apps`,
      activeWhen: "/en/apps",
    },
    {
      label: "Docs",
      href: ({ locale }) => `/${locale}/docs`,
      activeWhen: "/en/docs",
    },
    {
      label: "UI",
      href: ({ locale }) => `/${locale}/ui`,
      activeWhen: "/en/ui",
    },
  ],
} satisfies FibelHeaderConfig;

export const siteFooterLinks = [
  {
    label: "Source",
    value: "https://github.com/k2b-dev/cloud",
  },
  {
    label: "AGPL-3.0",
    value: "https://github.com/k2b-dev/cloud/blob/main/LICENSE",
  },
] satisfies NavLink[];
