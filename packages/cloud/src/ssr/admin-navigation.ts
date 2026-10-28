import { normalizeRedirectTo } from "../shared";
import { platformMessages } from "./platform-messages";
import type { RuntimeContext } from "./runtime";

/** `match` lists further paths the link stands for, such as the pages of an area. */
export type AdminLink = { href: string; icon: string; label: string; match?: string[] };
export type AdminGroup = { label: string; links: AdminLink[] };

const normalizeAdminHref = (href: string | undefined): string | undefined => {
  const normalized = normalizeRedirectTo(href);
  return normalized === "/admin" || normalized?.startsWith("/admin/") ? normalized : undefined;
};

export const buildAdminGroups = (apps: readonly RuntimeContext["apps"][number][], locale = "en"): AdminGroup[] => {
  const t = platformMessages.resolve([locale]).t;
  const settingsLinks: AdminLink[] = [
    { href: "/admin/settings?tab=general", icon: "ti-app-window", label: t.general },
    { href: "/admin/outgoing-mail", icon: "ti-mail", label: t.outgoingMail },
    { href: "/admin/settings?tab=pdf-rendering", icon: "ti-file-type-pdf", label: t.pdfRendering },
    { href: "/admin/places-and-maps", icon: "ti-map-2", label: t.placesAndMaps },
    { href: "/admin/settings?tab=email-templates", icon: "ti-template", label: t.emailTemplates },
    { href: "/admin/settings?tab=security", icon: "ti-shield-lock", label: t.security },
    { href: "/admin/settings?tab=legal", icon: "ti-file-text", label: t.legal },
  ];
  // Areas show as one entry each. The AI area belongs to Core; Observability exists when an app contributes it.
  const contributedApps = apps
    .map((app) => ({
      app,
      groups: (app.adminNav ?? [])
        .map((group) => ({
          section: group.section,
          label: group.label,
          links: group.links.flatMap((link) => {
            const href = normalizeAdminHref(link.href);
            return href ? [{ href, icon: link.icon.replace(/^ti\s+/, ""), label: link.label }] : [];
          }),
        }))
        .filter((group) => group.links.length > 0),
    }))
    .sort((a, b) => a.app.name.localeCompare(b.app.name));

  const appsWithGroups = new Set(contributedApps.filter(({ groups }) => groups.length > 0).map(({ app }) => app.id));
  const appLinks = apps
    .filter((app) => !appsWithGroups.has(app.id))
    .flatMap((app) => {
      const href = normalizeAdminHref(app.adminHref);
      return href ? [{ href, icon: app.icon.replace(/^ti\s+/, ""), label: app.name }] : [];
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const observabilityPaths = contributedApps.flatMap(({ groups }) =>
    groups.filter((group) => group.section === "observability").flatMap((group) => group.links.map((link) => link.href)),
  );
  const areaLinks: AdminLink[] = [
    { href: "/admin/ai", icon: "ti-sparkles", label: t.ai },
    ...(observabilityPaths.length > 0
      ? [{ href: "/admin/observability", icon: "ti-heart-rate-monitor", label: t.observability, match: observabilityPaths }]
      : []),
  ];

  return [
    {
      label: t.general,
      links: [
        { href: "/admin", icon: "ti-dashboard", label: t.overview },
        { href: "/admin/apps", icon: "ti-apps", label: t.apps },
        { href: "/admin/app-credentials", icon: "ti-key", label: t.appCredentials },
        { href: "/admin/rail", icon: "ti-layout-sidebar", label: t.rail },
        { href: "/admin/announcements", icon: "ti-speakerphone", label: t.announcements },
      ],
    },
    { label: t.cloudAreas, links: areaLinks },
    ...contributedApps.flatMap(({ groups }) =>
      groups.filter((group) => group.section === undefined).map(({ label, links }) => ({ label, links })),
    ),
    {
      label: t.userManagement,
      links: [
        { href: "/admin/settings?tab=user", icon: "ti-login", label: t.accountSignIn },
        { href: "/admin/settings?tab=registration", icon: "ti-user-plus", label: t.accountRegistration },
        { href: "/admin/settings?tab=linux", icon: "ti-terminal-2", label: t.linuxAccess },
        { href: "/admin/settings?tab=account-operations", icon: "ti-tool", label: t.accountOperations },
        { href: "/admin/settings?tab=freeipa", icon: "ti-building-fortress", label: "FreeIPA" },
      ],
    },
    { label: t.settings, links: settingsLinks },
    ...(appLinks.length > 0 ? [{ label: t.appAdmin, links: appLinks }] : []),
  ];
};
