import { adminNavigation } from "@k2b/cloud/ssr";
import { railAdminMessages } from "../rail/messages";

/** The sections of Apps: the registered apps and the shortcuts of the app bar ("Navigation"). */
export type AppsSection = "apps" | "navigation";

/** The admin bar with the sections of Apps one level in under its entry, the open one current. */
export const appsNav = (c: Parameters<typeof adminNavigation>[0], locale: string, current: AppsSection) => {
  const t = railAdminMessages.resolve([locale]).t;
  return adminNavigation(c, [
    { label: t.registered, icon: "apps", href: "/admin/apps", current: current === "apps" },
    { label: t.title, icon: "layout-sidebar", href: "/admin/apps/navigation", current: current === "navigation" },
  ]);
};

/** `/admin/rail` became the section Navigation of Apps; its address keeps its parameters. */
export const railRedirect = (url: string) => {
  const search = new URL(url).search;
  return `/admin/apps/navigation${search}`;
};
