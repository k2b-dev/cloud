import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Avatar, appWorkspaceLayoutStyle, LocaleProvider, NoticeCard } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { readAppWorkspaceLayoutCookie, resolveAppWorkspaceLayoutForSidebar } from "../_internal/app-workspace-state";
import { resolveNavMatch } from "../contracts/app"; // ==========================
import { hasRole, type User } from "../contracts/shared";
import { getLocale } from "../server/locale";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import { getDateConfig } from "../server/time";
import { dates } from "../shared";
import { readThemeFromCookieHeader } from "../shared/theme";
import AppLaunchpad, { type AppLaunchpadApp } from "./AppLaunchpad.island";
import AppWorkspaceController from "./AppWorkspaceController.island";
import { appAccentStyle, appAppearanceStyle, resolveCurrentApp } from "./app-appearance";
import { visibleNavigationApps } from "./app-navigation";
import BrowserNotifications from "./BrowserNotifications.island";
import Footer from "./Footer.island";
import GlobalAnnouncements from "./GlobalAnnouncements.island";
import type { GlobalSearchHelpApp } from "./GlobalSearchHelpDialog";
import GlobalSearchTrigger from "./GlobalSearchTrigger.island";
import HotkeysHelpRail from "./HotkeysHelpRail.island";
import LayoutBreadcrumbs from "./LayoutBreadcrumbs.island";
import type { LayoutBreadcrumb } from "./layout-runtime";
import NavMenu from "./NavMenu.island";
import RegisteredHelpDocuments from "./RegisteredHelpDocuments.island";
import { getRuntimeContext, type RuntimeContext } from "./runtime";
import ThemeToggleRail from "./ThemeToggleRail.island";
import TimezoneCookie from "./TimezoneCookie.island";

// Types
type Breadcrumb = LayoutBreadcrumb;
type AppLink = { id: string; iconClass: string; label: string; href: string; match: string; description?: string; accent?: string };
type LayoutContext = {
  get(key: "user"): User | undefined;
  get(key: "page"): { theme?: "light" | "dark"; lang?: string };
  get(key: "runtime"): RuntimeContext;
  get(key: "announcements"): LayoutAnnouncementsState | undefined;
  /**
   * Per-request settings snapshot (populated by snapshot middleware in
   * `_internal/define-app.ts`). Loose-typed at this layer so Layout can be
   * shared across apps with different SettingsMaps; reading core keys like
   * `app.name`/`app.copyright` is safe because every container's snapshot
   * includes core's keys.
   */
  get(key: "settings"): Record<string, any>;
  req: { raw: { headers: Headers; url: string } };
};
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
function active(pathname: string, match: string): string {
  return pathname.startsWith(match) ? "active" : "";
}
const jsonScript = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

function buildNavLinks(apps: RuntimeContext["apps"], user: User | undefined): { primary: AppLink[]; more: AppLink[] } {
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
    } satisfies AppLink,
  }));
  const primary = links.filter((entry) => entry.section === "primary").map((entry) => entry.link);
  const more = links.filter((entry) => entry.section === "more").map((entry) => entry.link);
  if (user && hasRole(user, "admin")) {
    more.push({
      id: "admin",
      iconClass: "ti ti-settings",
      label: "Admin",
      href: "/admin",
      match: "/admin",
      description: "Platform administration.",
      accent: undefined,
    });
  }
  return { primary, more };
} // ==========================
// Warning Components
const WARN_DAYS = 14;
function ProfileWarnings({ user }: { user: User }) {
  if (user.profile === "guest") return null;
  const missing: string[] = [];
  if (!user.displayName) missing.push("display name");
  if (!user.givenname) missing.push("first name");
  if (!user.sn) missing.push("last name");
  if (missing.length === 0) return null;
  return (
    <a href="/me" class="block shrink-0 no-underline">
      <NoticeCard tone="warning" icon={false} bodyClass="flex items-center gap-2">
        <i class="ti ti-user-exclamation" /> <span>Your profile is incomplete: {missing.join(",")} not set.</span>
      </NoticeCard>
    </a>
  );
}
function ExpiryWarnings({ user, dateConfig }: { user: User; dateConfig: DateContext }) {
  const now = Date.now();
  const warnThreshold = now + WARN_DAYS * 24 * 60 * 60 * 1000;
  const warnings: { icon: string; message: string; expired: boolean }[] = [];
  if (user.accountExpires) {
    const expires = new Date(user.accountExpires).getTime();
    const accountLabel = user.provider === "ipa" ? "account" : user.profile === "guest" ? "guest account" : "account";
    if (expires < now) warnings.push({ icon: "ti-calendar-event", message: "Your account has expired.", expired: true });
    else if (expires < warnThreshold)
      warnings.push({
        icon: "ti-calendar-event",
        message: `Your ${accountLabel} expires on ${dates.formatDate(user.accountExpires, dateConfig)}.`,
        expired: false,
      });
  }
  if (user.ipa?.passwordExpires) {
    const expires = new Date(user.ipa.passwordExpires).getTime();
    if (expires < now)
      warnings.push({ icon: "ti-key", message: "Your password has expired. Please log out and in again to change it.", expired: true });
    else if (expires < warnThreshold)
      warnings.push({
        icon: "ti-key",
        message: `Your password expires on ${dates.formatDate(user.ipa.passwordExpires, dateConfig)}.`,
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
  const runtime = getRuntimeContext(c);
  const cookie = c.req.raw.headers.get("Cookie") ?? "";
  c.get("page").theme = readThemeFromCookieHeader(cookie);
  // One request-scoped locale drives <html lang>, the LocaleProvider below,
  // and date formatting. The SSR seam resolves page.lang before render; the
  // fallback keeps directly rendered layouts (tests) on the same resolver.
  const dateConfig = getDateConfig(c);
  const lang = c.get("page").lang ?? getLocale(c);
  c.get("page").lang = lang;
  const user = c.get("user");
  const pathname = new URL(c.req.raw.url).pathname;
  const currentApp = resolveCurrentApp(runtime.apps, pathname);
  const registeredHelp = currentApp?.help;
  const workspaceLayout = resolveAppWorkspaceLayoutForSidebar(
    readAppWorkspaceLayoutCookie(cookie, currentApp?.id),
    workspaceSidebarCollapsible,
  );
  const { primary: primaryApps, more: moreApps } = buildNavLinks(runtime.apps, user);
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
  // Project the user record down to what NavMenu actually renders. Without
  // this, the full `User` (mail, ssh keys, phone, address, all group
  // memberships) gets serialized into the island's data-props HTML on every
  // authenticated page — defense-in-depth.
  const navMenuUser = user
    ? {
        id: user.id,
        uid: user.uid,
        displayName: user.displayName,
        profile: user.profile,
        roles: user.roles,
        avatarHash: user.avatarHash,
      }
    : undefined;
  // Aggregate legalLinks from every running app (last-wins on duplicate href).
  const legalLinks = (() => {
    const seen = new Map<string, { label: string; href: string; icon?: string }>();
    if (user) seen.set("/me", { label: "Profile", href: "/me", icon: "ti ti-user-circle" });
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
        data-workspace-sidebar-collapsed={workspaceLayout?.sidebarCollapsed ? "true" : undefined}
      >
        <TimezoneCookie />
        {registeredHelp && <RegisteredHelpDocuments documents={registeredHelp.documents} pageBase={registeredHelp.pageBase} />}
        <AppWorkspaceController appId={currentApp?.id} />
        {user && <BrowserNotifications userId={user.id} />}
        {showRail && <AppLaunchpad apps={launchpadApps} legalLinks={legalLinks} />}
        {showRail && (
          <script id="cloud-app-launchpad-data" type="application/json">
            {jsonScript({ apps: launchpadApps, legalLinks })}
          </script>
        )}{" "}
        {showRail && (
          <aside class="layout-rail hidden w-10 shrink-0 flex-col md:flex">
            <div class="layout-rail-logo flex h-[2.875rem] shrink-0 items-center justify-center">
              <a href="/" aria-label="Home">
                <img src="/branding/logo" alt="Logo" class="h-5 w-5" />
              </a>
            </div>
            <nav class="layout-rail-navigation flex min-h-0 flex-1 flex-col items-center gap-1" aria-label="Apps">
              {primaryApps.map((app) => (
                <a
                  href={app.href}
                  class={`rail-item ${active(pathname, app.match) ? "rail-item-active" : ""}`}
                  aria-label={app.label}
                  aria-current={active(pathname, app.match) ? "page" : undefined}
                  title={app.label}
                  style={appAccentStyle(app.accent)}
                >
                  <i class={`${app.iconClass} text-base`} />
                </a>
              ))}
              <AppLaunchpad apps={launchpadApps} legalLinks={legalLinks} variant="rail" label="Open apps" />
              <div class="mt-auto flex flex-col items-center gap-1">
                <GlobalSearchTrigger variant="rail" searchHelpApps={searchHelpApps} />
                <HotkeysHelpRail variant="rail" registerHotkey searchHelpApps={searchHelpApps} accent={currentApp?.appearance?.accent} />
                <ThemeToggleRail />
              </div>
            </nav>
          </aside>
        )}
        <div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            class="layout-header paper flex min-h-[2.875rem] shrink-0 items-center justify-between px-2 py-1.5 md:px-3 md:py-2"
            style="box-shadow: var(--ui-shadow-surface)"
          >
            <div class="flex min-w-0 items-center gap-2">
              {!showRail && (
                <a href="/" class="flex shrink-0 items-center" aria-label="Home">
                  <img src="/branding/logo" alt="Logo" class="h-6 w-6" />
                </a>
              )}
              {showRail && (
                <a
                  href="/"
                  aria-label="Home"
                  class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-zinc-100 hover:text-secondary md:hidden dark:hover:bg-zinc-800"
                >
                  <img src="/branding/logo" alt="Home" class="h-4 w-4" />
                </a>
              )}
              <div class="hidden min-w-0 items-center md:flex">
                <LayoutBreadcrumbs breadcrumbs={breadcrumbs} />
              </div>
              <div class="flex min-w-0 items-center md:hidden">
                <LayoutBreadcrumbs breadcrumbs={breadcrumbs} mobile />
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <div class="flex items-center gap-1 md:hidden">
                <HotkeysHelpRail
                  variant="header"
                  registerHotkey={!showRail}
                  searchHelpApps={searchHelpApps}
                  accent={currentApp?.appearance?.accent}
                />
                {user && <GlobalSearchTrigger variant="header" registerHotkey searchHelpApps={searchHelpApps} />}
              </div>
              {user ? (
                <>
                  <a href="/me" class="hidden cursor-pointer items-center justify-center md:flex" aria-label="Profile">
                    <Avatar
                      name={user.displayName || user.uid}
                      src={
                        user.avatarHash
                          ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}`
                          : undefined
                      }
                      size="xs"
                    />
                  </a>
                  <div class="md:hidden">
                    <div class="flex items-center gap-1">
                      <AppLaunchpad apps={launchpadApps} legalLinks={legalLinks} variant="header" label="Open apps" />
                    </div>
                  </div>
                </>
              ) : (
                <NavMenu user={navMenuUser} />
              )}
            </div>
          </header>
          {user && announcements && (
            <GlobalAnnouncements
              banners={announcements.banners}
              announcements={announcements.announcements}
              latestAnnouncementVersion={announcements.latestAnnouncementVersion}
              cookieState={announcements.cookieState}
            />
          )}
          {user && <ProfileWarnings user={user} />}
          {user && <ExpiryWarnings user={user} dateConfig={dateConfig} />}
          <main class={`layout-content-main min-h-0 min-w-0 flex-1 ${mainLayoutClass}`}>
            <AppWorkspace.LayoutStateProvider state={workspaceLayout}>{props.children}</AppWorkspace.LayoutStateProvider>
          </main>
          {!fullPage && !showRail && (
            <div class="hidden shrink-0 md:block">
              <Footer isLoggedIn={!!user} appName={settings?.app?.copyright || appName} legalLinks={legalLinks} />
            </div>
          )}
        </div>
      </div>
    </LocaleProvider>
  );
}
