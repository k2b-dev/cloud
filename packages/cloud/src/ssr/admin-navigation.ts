import { normalizeRedirectTo } from "../shared";
import { platformMessages } from "./platform-messages";
import type { RuntimeContext } from "./runtime";

export type AdminLink = { href: string; icon: string; label: string };
export type AdminGroup = { label: string; links: AdminLink[] };

const normalizeAdminHref = (href: string | undefined): string | undefined => {
  const normalized = normalizeRedirectTo(href);
  return normalized === "/admin" || normalized?.startsWith("/admin/") ? normalized : undefined;
};

export const buildAdminGroups = (apps: readonly RuntimeContext["apps"][number][], locale = "en"): AdminGroup[] => {
  const t = platformMessages.resolve([locale]).t;
  const settingsLinks: AdminLink[] = [
    { href: "/admin/settings?tab=general", icon: "ti-app-window", label: t.general },
    { href: "/admin/settings?tab=user", icon: "ti-users", label: t.userManagement },
    { href: "/admin/settings?tab=freeipa", icon: "ti-building-fortress", label: "FreeIPA" },
    { href: "/admin/settings?tab=linux", icon: "ti-terminal-2", label: t.linuxAccess },
    { href: "/admin/settings?tab=mail", icon: "ti-mail", label: "Mail" },
    { href: "/admin/settings?tab=pdf-rendering", icon: "ti-file-type-pdf", label: t.pdfRendering },
    { href: "/admin/settings?tab=email-templates", icon: "ti-template", label: t.emailTemplates },
    { href: "/admin/settings?tab=security", icon: "ti-shield-lock", label: t.security },
    { href: "/admin/settings?tab=legal", icon: "ti-file-text", label: t.legal },
  ];
  const aiLinks: AdminLink[] = [
    { href: "/admin/settings?tab=ai-general", icon: "ti-adjustments", label: t.general },
    { href: "/admin/settings?tab=ai-providers", icon: "ti-sparkles", label: t.providers },
    { href: "/admin/settings?tab=ai-skills", icon: "ti-wand", label: t.skills },
    { href: "/admin/settings?tab=ai-projects", icon: "ti-folders", label: t.projects },
    { href: "/admin/settings?tab=ai-jobs", icon: "ti-activity", label: t.backgroundJobs },
  ];
  const contributedApps = apps
    .map((app) => ({
      app,
      groups: (app.adminNav ?? [])
        .map((group) => ({
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

  return [
    {
      label: t.general,
      links: [
        { href: "/admin", icon: "ti-dashboard", label: t.overview },
        { href: "/admin/announcements", icon: "ti-speakerphone", label: t.announcements },
      ],
    },
    ...contributedApps.flatMap(({ groups }) => groups),
    { label: t.ai, links: aiLinks },
    { label: t.settings, links: settingsLinks },
    ...(appLinks.length > 0 ? [{ label: t.appAdmin, links: appLinks }] : []),
  ];
};
