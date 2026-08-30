import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, appWorkspaceLayoutStyle, LocaleProvider, NoticeCard } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { readAppWorkspaceLayoutCookie, resolveAppWorkspaceLayoutForSidebar } from "../_internal/app-workspace-state";
import { resolveNavMatch } from "../contracts/app"; // ==========================
import { hasRole, type User } from "../contracts/shared";
import { getLocale } from "../server/locale";
import { getDateConfig } from "../server/time";
import { dates, resolveHelpManifest } from "../shared";
import { readThemeFromCookieHeader } from "../shared/theme";
import type { AppLaunchpadApp } from "./AppLaunchpad.island";
import AppWorkspaceController from "./AppWorkspaceController.island";
import { appAppearanceStyle, resolveCurrentApp } from "./app-appearance";
import { visibleNavigationApps } from "./app-navigation";
import BrowserNotifications from "./BrowserNotifications.island";
import GlobalAnnouncements from "./GlobalAnnouncements.island";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import type { LayoutContext } from "./layout-context";
import LayoutFooter from "./LayoutFooter";
import LayoutHeader from "./LayoutHeader";
import type { LayoutBreadcrumb } from "./layout-runtime";
import LayoutRail, { type LayoutAppLink } from "./LayoutRail";
import { platformMessages } from "./platform-messages";
import RegisteredHelpDocuments from "./RegisteredHelpDocuments.island";
import { getLocalizedRuntimeContext, type RuntimeContext } from "./runtime";
import TimezoneCookie from "./TimezoneCookie.island";

// Types
type Breadcrumb = LayoutBreadcrumb;
type LayoutProps = {
  children: JSX.Element;
  c: LayoutContext;
  title?: string | Breadcrumb[];
  fullPage?: boolean /** Keep the shell viewport-bound and suppress its footer. */;
  fullWidth?: boolean /** Delegate scrolling and clipping to the page's work surface. */;
  focusMode?: boolean /** Render only the app canvas and content for dedicated editors or pop-out windows. */;
  flushCanvas?: boolean /** Remove app-canvas spacing for edge-to-edge focus surfaces such as pop-out windows. */;
  workspaceSidebarCollapsible?: boolean /** Resolve persisted sidebar geometry for the page's sidebar policy during SSR. */;
}; // ==========================
// Helpers
function buildNavLinks(
  apps: RuntimeContext["apps"],
  user: User | undefined,
  locale: string,
): { primary: LayoutAppLink[]; more: LayoutAppLink[] } {
  const t = platformMessages.resolve([locale]).t;
  const links = visibleNavigationApps(apps, user).map((app) => ({
    section: app.nav.section,
    link: {
      iconClass: app.icon,
      id: app.id,
      label: app.name,
      href: app.nav.href,
      match: resolveNavMatch(app) ?? app.nav.href.split("?")[0] ?? app.nav.href,
      description: app.description,
      accent: app.appearance?.accent,
    } satisfies LayoutAppLink,
  }));
  const primary = links.filter((entry) => entry.section === "primary").map((entry) => entry.link);
  const more = links.filter((entry) => entry.section === "more").map((entry) => entry.link);
  if (user && hasRole(user, "admin")) {
    more.push({
      id: "admin",
      iconClass: "ti ti-settings",
      label: t.admin,
      href: "/admin",
      match: "/admin",
      description: t.platformAdministration,
      accent: undefined,
    });
  }
  return { primary, more };
} // ==========================
// Warning Components
const WARN_DAYS = 14;
function ProfileWarnings({ user, locale }: { user: User; locale: string }) {
  const t = platformMessages.resolve([locale]).t;
  if (user.profile === "guest") return null;
  const missing: string[] = [];
  if (!user.displayName) missing.push(t.displayName);
  if (!user.givenname) missing.push(t.firstName);
  if (!user.sn) missing.push(t.lastName);
  if (missing.length === 0) return null;
  return (
    <a href="/me" class="block shrink-0 no-underline">
      <NoticeCard tone="warning" icon={false} bodyClass="flex items-center gap-2">
        <i class="ti ti-user-exclamation" /> <span>{t.profileIncomplete({ fields: missing.join(", ") })}</span>
      </NoticeCard>
    </a>
  );
}
function ExpiryWarnings({ user, dateConfig, locale }: { user: User; dateConfig: DateContext; locale: string }) {
  const t = platformMessages.resolve([locale]).t;
  const now = Date.now();
  const warnThreshold = now + WARN_DAYS * 24 * 60 * 60 * 1000;
  const warnings: { icon: string; message: string; expired: boolean }[] = [];
  if (user.accountExpires) {
    const expires = new Date(user.accountExpires).getTime();
    if (expires < now) warnings.push({ icon: "ti-calendar-event", message: t.accountExpired, expired: true });
    else if (expires < warnThreshold)
      warnings.push({
        icon: "ti-calendar-event",
        message:
          user.profile === "guest"
            ? t.guestAccountExpires({ date: dates.formatDate(user.accountExpires, dateConfig) })
            : t.accountExpires({ date: dates.formatDate(user.accountExpires, dateConfig) }),
        expired: false,
      });
  }
  if (user.ipa?.passwordExpires) {
    const expires = new Date(user.ipa.passwordExpires).getTime();
    if (expires < now) warnings.push({ icon: "ti-key", message: t.passwordExpired, expired: true });
    else if (expires < warnThreshold)
      warnings.push({
        icon: "ti-key",
        message: t.passwordExpires({ date: dates.formatDate(user.ipa.passwordExpires, dateConfig) }),
        expired: false,
      });
  }
  if (warnings.length === 0) return null;
  return (
    <div class="flex shrink-0 flex-col gap-1">
      {" "}
      {warnings.map((w) => (
        <NoticeCard tone={w.expired ? "danger" : "warning"} icon={false} bodyClass="flex items-center gap-2">
          {" "}
          <i class={`ti ${w.icon}`} /> <span>{w.message}</span>{" "}
        </NoticeCard>
      ))}{" "}
    </div>
  );
} // ==========================
// Sub-Components
// ==========================
// Main Layout
// `children` stays on `props` so the getter runs inside the provider subtree
// below; eager destructuring would render children before `LocaleProvider`
// (and the workspace layout provider) exist.
export default function Layout(props: LayoutProps) {
  const { c, title, fullPage, fullWidth, focusMode, flushCanvas, workspaceSidebarCollapsible } = props;
  const runtime = getLocalizedRuntimeContext(c);
  const cookie = c.req.raw.headers.get("Cookie") ?? "";
  const theme = readThemeFromCookieHeader(cookie);
  c.get("page").theme = theme;
  // One request-scoped locale drives <html lang>, the LocaleProvider below,
  // and date formatting. The SSR seam and this component both resolve through
  // the same canonical getLocale(c), so pages cannot diverge the three seams.
  const dateConfig = getDateConfig(c);
  const lang = getLocale(c);
  const t = platformMessages.resolve([lang]).t;
  const user = c.get("user");
  const pathname = new URL(c.req.raw.url).pathname;
  const currentApp = resolveCurrentApp(runtime.apps, pathname);
  const registeredHelp = currentApp?.help ? resolveHelpManifest(currentApp.help, lang) : undefined;
  const workspaceLayout = resolveAppWorkspaceLayoutForSidebar(
    readAppWorkspaceLayoutCookie(cookie, currentApp?.id),
    workspaceSidebarCollapsible,
  );
  const { primary: primaryApps, more: moreApps } = buildNavLinks(runtime.apps, user, lang);
  const allApps = [...primaryApps, ...moreApps];
  const launchpadApps: AppLaunchpadApp[] = allApps.map((app) => ({
    id: app.id,
    iconClass: app.iconClass,
    label: app.label,
    href: app.href,
    description: app.description,
    accent: app.accent,
  }));
  const searchHelpApps: GlobalSearchHelpApp[] = runtime.apps
    .filter((app) => (app.searchTags?.length ?? 0) > 0)
    .map((app) => ({
      appId: app.id,
      appName: app.name,
      appIcon: app.icon,
      help: app.searchHelp,
      tags: [...new Set((app.searchTags ?? []).map((tag) => tag.toLowerCase()))],
      tagHelp: [...(app.searchTagHelp ?? [])],
    }))
    .sort((a, b) => a.appName.localeCompare(b.appName));
  const settings = c.get("settings");
  const announcements = c.get("announcements");
  const appName = settings?.app?.name || "Cloud";
  // Aggregate legalLinks from every running app (last-wins on duplicate href).
  const legalLinks = (() => {
    const seen = new Map<string, { label: string; href: string; icon?: string }>();
    if (user) seen.set("/me", { label: t.profile, href: "/me", icon: "ti ti-user-circle" });
    for (const app of runtime.apps) {
      for (const link of app.legalLinks ?? []) seen.set(link.href, { ...link });
    }
    return [...seen.values()];
  })();
  const page = c.get("page") as Record<string, unknown>;
  const pageTitle = typeof title === "string" ? title : (title?.at(-1)?.title ?? appName);
  if (!page.title) page.title = pageTitle;
  const breadcrumbs: Breadcrumb[] = !title ? [{ title: appName }] : typeof title === "string" ? [{ title }] : title;
  const showRail = !!user;
  const profileName = user?.displayName || user?.uid || "?";
  const profileAvatarSrc =
    user?.avatarHash && user.id
      ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}`
      : undefined;
  const mainLayoutClass = fullPage || fullWidth ? "flex flex-col" : "md:overflow-auto";
  const canvasStyle =
    [appAppearanceStyle(currentApp?.appearance), appWorkspaceLayoutStyle(workspaceLayout), focusMode && flushCanvas ? "padding:0" : ""]
      .filter(Boolean)
      .join(";") || undefined;
  if (focusMode) {
    return (
      <LocaleProvider locale={lang}>
        <div
          class="cloud-app-canvas flex h-dvh w-full overflow-hidden"
          style={canvasStyle}
          data-app-id={currentApp?.id}
          data-workspace-sidebar-collapsed={workspaceLayout?.sidebarCollapsed ? "true" : undefined}
        >
          <TimezoneCookie />
          {registeredHelp && <RegisteredHelpDocuments documents={registeredHelp.documents} pageBase={registeredHelp.pageBase} />}
          <main class="min-h-0 min-w-0 flex-1">
            <AppWorkspace.LayoutStateProvider state={workspaceLayout}>{props.children}</AppWorkspace.LayoutStateProvider>
          </main>
        </div>
      </LocaleProvider>
    );
  }
  return (
    <LocaleProvider locale={lang}>
      <div
        class={`cloud-app-canvas relative flex w-full ${fullPage ? "h-dvh overflow-hidden" : "min-h-screen md:h-screen md:overflow-hidden"}`}
        style={canvasStyle}
        data-app-id={currentApp?.id}
        data-layout-authenticated={showRail ? "true" : undefined}
        data-workspace-sidebar-collapsed={workspaceLayout?.sidebarCollapsed ? "true" : undefined}
      >
        <TimezoneCookie />
        {registeredHelp && <RegisteredHelpDocuments documents={registeredHelp.documents} pageBase={registeredHelp.pageBase} />}
        <AppWorkspaceController appId={currentApp?.id} />
        {user && <BrowserNotifications userId={user.id} />}
        {showRail && (
          <LayoutRail
            accent={currentApp?.appearance?.accent}
            appsLabel={t.apps}
            homeLabel={t.home}
            launchpadApps={launchpadApps}
            legalLinks={legalLinks}
            openAppsLabel={t.openApps}
            pathname={pathname}
            primaryApps={primaryApps}
            profileAvatarSrc={profileAvatarSrc}
            profileName={profileName}
            searchHelpApps={searchHelpApps}
            theme={theme}
          />
        )}
        <div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col">
          <LayoutHeader
            accent={currentApp?.appearance?.accent}
            authenticated={showRail}
            breadcrumbs={breadcrumbs}
            homeLabel={t.home}
            launchpadApps={launchpadApps}
            legalLinks={legalLinks}
            openAppsLabel={t.openApps}
            profileAvatarSrc={profileAvatarSrc}
            profileName={profileName}
            searchHelpApps={searchHelpApps}
            signInLabel={t.signIn}
            theme={theme}
          />
          {user && announcements && (
            <GlobalAnnouncements
              banners={announcements.banners}
              announcements={announcements.announcements}
              latestAnnouncementVersion={announcements.latestAnnouncementVersion}
              cookieState={announcements.cookieState}
            />
          )}
          {user && <ProfileWarnings user={user} locale={lang} />}
          {user && <ExpiryWarnings user={user} dateConfig={dateConfig} locale={lang} />}
          <main class={`layout-content-main min-h-0 min-w-0 flex-1 ${mainLayoutClass}`}>
            <AppWorkspace.LayoutStateProvider state={workspaceLayout}>{props.children}</AppWorkspace.LayoutStateProvider>
          </main>
          {!fullPage && !showRail && <LayoutFooter appName={settings?.app?.copyright || appName} legalLinks={legalLinks} />}
        </div>
      </div>
    </LocaleProvider>
  );
}
