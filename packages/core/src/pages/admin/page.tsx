import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation, getDisplayRuntimeContext, hasDedicatedRuntimeRoute } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { adminMessages } from "./messages";
import type { OverviewSection, OverviewTask } from "./OverviewScreen";
import OverviewScreen from "./OverviewScreen.island";

type Messages = ReturnType<typeof adminMessages.resolve>["t"];

const platformTasks = (t: Messages): OverviewTask[] => [
  { href: "/admin/apps", title: t.apps, description: t.appsDescription, icon: "apps" },
  { href: "/admin/rail", title: t.rail, description: t.railDescription, icon: "layout-sidebar" },
  { href: "/admin/base", title: t.generalSettings, description: t.generalSettingsDescription, icon: "app-window" },
  { href: "/admin/storage", title: t.storageSettings, description: t.storageSettingsDescription, icon: "database" },
  { href: "/admin/signin/security", title: t.security, description: t.securityDescription, icon: "shield-lock" },
  { href: "/admin/outgoing-mail", title: t.mail, description: t.mailDescription, icon: "mail" },
  { href: "/admin/ai", title: t.aiProviders, description: t.aiProvidersDescription, icon: "sparkles" },
  { href: "/admin/announcements", title: t.announcements, description: t.announcementsDescription, icon: "speakerphone" },
  { href: "/admin/base/legal", title: t.legal, description: t.legalDescription, icon: "file-text" },
];

/** "ti ti-box" of an app's declaration is the v2 name "box". */
const v2Icon = (icon: string) => icon.replace(/^ti\s+/, "").replace(/^ti-/, "");

/** The admin overview: where to start, the platform's settings, and the admin pages apps bring along. */
export default ssr<AuthContext>(async (c) => {
  const t = adminMessages.resolve([getLocale(c)]).t;
  const allApps = getDisplayRuntimeContext(c).apps;
  const adminApps = allApps.filter((app) => !!app.adminHref && app.id !== "gateway-ops").sort((a, b) => a.name.localeCompare(b.name));
  // Apps and routes are a section of the Observability area.
  const observability = hasDedicatedRuntimeRoute(allApps, "/admin/observability", "core");
  const start: OverviewTask[] = [
    observability
      ? { href: "/admin/observability", title: t.investigateSystem, description: t.investigateDescription, icon: "stethoscope" }
      : { href: "/admin/base", title: t.configureInstance, description: t.configureDescription, icon: "settings" },
    observability
      ? { href: "/admin/apps", title: t.appsAndRoutes, description: t.appsAndRoutesDescription, icon: "route-scan" }
      : { href: "/admin/announcements", title: t.announcements, description: t.announcementsDescription, icon: "speakerphone" },
    { href: "/admin/signin", title: t.peopleAndAccess, description: t.peopleAndAccessDescription, icon: "users" },
  ];
  const sections: OverviewSection[] = [
    { title: t.startHere, summary: t.chooseTask, tasks: start },
    { title: t.platformConfiguration, summary: t.platformConfigurationDescription, tasks: platformTasks(t) },
    {
      title: t.appAdministration,
      summary: t.appAdministrationDescription,
      tasks: adminApps.map((app) => ({ href: app.adminHref!, title: app.name, description: app.description, icon: v2Icon(app.icon) })),
    },
  ];

  return () => (
    <AdminLayout c={c} ui="v2" title={t.overview}>
      <OverviewScreen
        nav={adminNavigation(c)}
        title={t.administration}
        lead={t.registeredServices({ count: allApps.length })}
        facts={[t.appAdminAreas({ count: adminApps.length })]}
        sections={sections}
      />
    </AdminLayout>
  );
});
