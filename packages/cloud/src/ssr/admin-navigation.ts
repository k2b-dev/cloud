import { approvalMessages } from "../approvals/messages";
import { normalizeRedirectTo } from "../shared";
import { platformMessages } from "./platform-messages";
import type { RuntimeContext } from "./runtime";

/** `match` lists further paths the link stands for, such as the pages of an area. */
export type AdminLink = { href: string; icon: string; label: string; match?: string[]; waiting?: { count: number; label: string } };
/** A group without `label` stands at the top without a heading, such as the overview. */
export type AdminGroup = { label?: string; links: AdminLink[] };

const normalizeAdminHref = (href: string | undefined): string | undefined => {
  const normalized = normalizeRedirectTo(href);
  return normalized === "/admin" || normalized?.startsWith("/admin/") ? normalized : undefined;
};

/**
 * The admin bar: the overview, then what an operator sets up once, then what they run every day, then one entry per
 * app with settings of its own. Only the links are grouped here; no page and no address moves.
 */
export const buildAdminGroups = (
  apps: readonly RuntimeContext["apps"][number][],
  locale = "en",
  status: { codeApprovals?: number } = {},
): AdminGroup[] => {
  const t = platformMessages.resolve([locale]).t;
  const codeApprovals = status.codeApprovals;
  // Areas show as one entry each. The AI area belongs to Core; Observability exists when an app contributes it.
  const contributedApps = apps
    .map((app) => ({
      app,
      groups: (app.adminNav ?? [])
        .map((group) => ({
          section: group.section,
          label: group.label,
          links: group.links.flatMap((link) => {
            // People is the page of the app that manages accounts and groups, which lives in that app.
            const href = group.section === "people" ? normalizeRedirectTo(link.href) : normalizeAdminHref(link.href);
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

  const contributed = (section: "observability" | "people") =>
    contributedApps.flatMap(({ groups }) => groups.filter((group) => group.section === section).flatMap((group) => group.links));
  const observabilityPaths = contributed("observability").map((link) => link.href);

  return [
    { links: [{ href: "/admin", icon: "ti-dashboard", label: t.overview }] },
    {
      label: t.adminSetup,
      links: [
        { href: "/admin/base", icon: "ti-adjustments", label: t.baseSettings },
        { href: "/admin/settings?tab=storage", icon: "ti-database", label: t.storage },
        { href: "/admin/signin", icon: "ti-shield-lock", label: t.signinSecurity },
        { href: "/admin/outgoing-mail", icon: "ti-mail", label: t.outgoingMail },
        { href: "/admin/settings?tab=email-templates", icon: "ti-template", label: t.emailTemplates },
        { href: "/admin/announcements", icon: "ti-speakerphone", label: t.announcements },
        { href: "/admin/ai", icon: "ti-sparkles", label: t.ai },
      ],
    },
    {
      label: t.adminOperations,
      links: [
        { href: "/admin/apps", icon: "ti-apps", label: t.apps },
        { href: "/admin/rail", icon: "ti-layout-sidebar", label: t.rail },
        {
          href: "/admin/code",
          icon: "ti-code",
          label: t.code,
          ...(codeApprovals
            ? { waiting: { count: codeApprovals, label: approvalMessages.resolve([locale]).t.waiting({ count: codeApprovals }) } }
            : {}),
        },
        ...(observabilityPaths.length > 0
          ? [
              {
                // Gateway Ops owns the area's start; without it, the entry opens the first contributed page.
                href: observabilityPaths.includes("/admin/observability") ? "/admin/observability" : observabilityPaths[0]!,
                icon: "ti-heart-rate-monitor",
                label: t.observability,
                match: observabilityPaths,
              },
            ]
          : []),
        ...contributed("people"),
      ],
    },
    ...contributedApps.flatMap(({ groups }) =>
      groups.filter((group) => group.section === undefined).map(({ label, links }) => ({ label, links })),
    ),
    ...(appLinks.length > 0 ? [{ label: t.appSettings, links: appLinks }] : []),
  ];
};
