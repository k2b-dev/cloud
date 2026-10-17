import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, appWorkspaceLayoutStyle, keyboardPlatform, LocaleProvider, NoticeCard, PageTrailProvider } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { readAppWorkspaceLayoutCookie, resolveAppWorkspaceLayoutForSidebar } from "../_internal/app-workspace-state";
import { readShellFocusCookie } from "../_internal/shell-focus";
import { resolveNavMatch } from "../contracts/app"; // ==========================
import { isPwaShellAvailable } from "../contracts/pwa";
import { defaultRailPreferences } from "../contracts/rail-preferences";
import { hasRole, type User } from "../contracts/shared";
import { getLocale } from "../server/locale";
import { getDateConfig } from "../server/time";
import { dates, normalizeRedirectTo } from "../shared";
import { readThemePreferenceFromCookieHeader } from "../shared/theme";
import AnnouncementBanners from "./AnnouncementBanners";
import { appAppearanceStyle, resolveCurrentApp } from "./app-appearance";
import { resolveRuntimeRoute, visibleNavigationApps } from "./app-navigation";
import { getLayoutHelp, layoutHelpFailed } from "./help";
import LayoutFooter from "./LayoutFooter";
import LayoutHeader from "./LayoutHeader";
import LayoutRail, { type LayoutAppLink } from "./LayoutRail";
import LayoutTabBar from "./LayoutTabBar";
import type { LayoutContext } from "./layout-context";
import { HELP_VIEW_LIMIT } from "./layout-help-start";
import type { LayoutBreadcrumb } from "./layout-runtime";
import PageTrailRow from "./PageTrailRow";
import { derivePageTrail } from "./page-trail";
import { platformMessages } from "./platform-messages";
import { sortRailApps } from "./rail-navigation";
import { requestPath } from "./request-path";
import { getLocalizedRuntimeContext, type RuntimeContext } from "./runtime";
import ShellFocusToggle from "./ShellFocusToggle";
import ShellRuntime from "./ShellRuntime.island";
import { type ShellData, ShellDataProvider } from "./shell-data";

// Types
type Breadcrumb = LayoutBreadcrumb;
type LayoutProps = {
  children: JSX.Element;
  c: LayoutContext;
  title?: string | Breadcrumb[];
  /** Up to three ids of the current app's Help articles that fit this page; Help lists them first under "For this view". Unknown ids and articles the reader may not see are ignored. */
  help?: readonly string[];
  fullPage?: boolean /** Keep the shell viewport-bound and suppress its footer. */;
  fullWidth?: boolean /** Delegate scrolling and clipping to the page's work surface. */;
  focusMode?: boolean /** Render only the app canvas and content for dedicated editors or pop-out windows. */;
  flushCanvas?: boolean /** Remove app-canvas spacing for edge-to-edge focus surfaces such as pop-out windows. */;
  /** Final localized app-specific export or printing guidance, shown when no data-print-region exists. */
  printHint?: string;
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
      defaultVisible: app.nav.section === "primary",
      id: app.id,
      label: app.name,
      href: app.nav.href,
      match: resolveNavMatch(app) ?? app.nav.href.split("?")[0] ?? app.nav.href,
      description: app.description,
      accent: app.appearance?.accent,
      badge: app.nav.badge,
    } satisfies LayoutAppLink,
  }));
  const primary = links.filter((entry) => entry.section === "primary").map((entry) => entry.link);
  const more = links.filter((entry) => entry.section === "more").map((entry) => entry.link);
  if (user && hasRole(user, "admin")) {
    more.push({
      id: "admin",
      defaultVisible: false,
      iconClass: "ti ti-settings",
      label: t.admin,
      href: "/admin",
      match: "/admin",
      description: t.platformAdministration,
      accent: undefined,
      badge: undefined,
    });
  }
  return { primary, more };
} /** The page `/` opens, by Core's rule for `app.home_path`: a local path other than `/`, sign-in, or admin. */
const startPagePath = (value: unknown): string => {
  const path = typeof value === "string" ? normalizeRedirectTo(value) : undefined;
  return !path || path === "/" || /^\/(?:auth|admin)(?:\/|$)/.test(path) ? "/app/dashboard" : path;
};
// ==========================
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
      <NoticeCard tone="warning">{t.profileIncomplete({ fields: missing.join(", ") })}</NoticeCard>
    </a>
  );
}
function ExpiryWarnings({ user, dateConfig, locale }: { user: User; dateConfig: DateContext; locale: string }) {
  const t = platformMessages.resolve([locale]).t;
  const now = Date.now();
  const warnThreshold = now + WARN_DAYS * 24 * 60 * 60 * 1000;
  const warnings: { message: string; expired: boolean }[] = [];
  if (user.accountExpires) {
    const expires = new Date(user.accountExpires).getTime();
    if (expires < now) warnings.push({ message: t.accountExpired, expired: true });
    else if (expires < warnThreshold)
      warnings.push({
        message:
          user.profile === "guest"
            ? t.guestAccountExpires({ date: dates.formatDate(user.accountExpires, dateConfig) })
            : t.accountExpires({ date: dates.formatDate(user.accountExpires, dateConfig) }),
        expired: false,
      });
  }
  if (user.ipa?.passwordExpires) {
    const expires = new Date(user.ipa.passwordExpires).getTime();
    if (expires < now) warnings.push({ message: t.passwordExpired, expired: true });
    else if (expires < warnThreshold)
      warnings.push({
        message: t.passwordExpires({ date: dates.formatDate(user.ipa.passwordExpires, dateConfig) }),
        expired: false,
      });
  }
  if (warnings.length === 0) return null;
  return (
    <div class="flex shrink-0 flex-col gap-1">
      {" "}
      {warnings.map((w) => (
        <NoticeCard tone={w.expired ? "danger" : "warning"}>{w.message}</NoticeCard>
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
  const theme = readThemePreferenceFromCookieHeader(cookie);
  // One request-scoped locale drives <html lang>, the LocaleProvider below,
  // and date formatting. The SSR seam and this component both resolve through
  // the same canonical getLocale(c), so pages cannot diverge the three seams.
  const dateConfig = getDateConfig(c);
  const lang = getLocale(c);
  const t = platformMessages.resolve([lang]).t;
  const user = c.get("user");
  const pathname = new URL(c.req.raw.url).pathname;
  const currentRoute = resolveRuntimeRoute(runtime.apps, pathname);
  const currentApp = resolveCurrentApp(runtime.apps, pathname);
  const registeredHelp = getLayoutHelp(c);
  const runtimeHelp = registeredHelp ? { documents: registeredHelp.documents, pageBase: registeredHelp.pageBase } : undefined;
  const workspaceLayout = resolveAppWorkspaceLayoutForSidebar(
    readAppWorkspaceLayoutCookie(cookie, currentApp?.id),
    workspaceSidebarCollapsible,
  );
  const { primary: primaryApps, more: moreApps } = buildNavLinks(runtime.apps, user, lang);
  const allApps = sortRailApps([...primaryApps, ...moreApps], lang);
  const visibleAppIds = new Set(allApps.map((app) => app.id));
  const searchLinks = Object.fromEntries(
    runtime.apps.flatMap((app) => (visibleAppIds.has(app.id) && app.searchLinks?.length ? [[app.id, app.searchLinks] as const] : [])),
  );
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
  // The way up is derived from the title array by one rule (see `derivePageTrail`). Anonymous pages keep their
  // header breadcrumbs, and focus surfaces such as pop-out editors have no way up; both show the title alone. The
  // canvas carries this for `layout.update()`.
  const titleOnly = !user || focusMode;
  const pageTrail = titleOnly
    ? { title: pageTitle, ancestors: [] }
    : derivePageTrail(title ?? appName, currentRoute?.prefix, appName, `${pathname}${new URL(c.req.raw.url).search}`);
  const showRail = !!user;
  // The app bar and the app's navigation hidden with Cmd/Ctrl+\ or the sidebar buttons; phones ignore it in CSS.
  const shellFocus = showRail && readShellFocusCookie(cookie);
  // The profile menu offers the mobile app only while the installation runs it.
  const appHref = user && isPwaShellAvailable(runtime.apps) ? "/me/app" : undefined;
  const profileName = user?.displayName || user?.uid || "?";
  const profileAvatarSrc =
    user?.avatarHash && user.id
      ? `/api/accounts/users/${encodeURIComponent(user.id)}/avatar?rev=${encodeURIComponent(user.avatarHash)}`
      : undefined;
  // From md, `main` is the page scroller of regular pages. Its stable gutter
  // keeps short and long pages at the same width where scrollbars take space.
  const mainLayoutClass = fullPage || fullWidth ? "flex flex-col" : "md:overflow-auto md:[scrollbar-gutter:stable]";
  const canvasStyle =
    [appAppearanceStyle(currentApp?.appearance), appWorkspaceLayoutStyle(workspaceLayout), focusMode && flushCanvas ? "padding:0" : ""]
      .filter(Boolean)
      .join(";") || undefined;
  const appLabel = currentApp?.name ?? (pathname.startsWith("/admin") ? t.admin : undefined);
  const helpIds = new Set(registeredHelp?.documents.map((topic) => topic.id));
  const viewHelp = [...new Set(props.help)].filter((id) => helpIds.has(id)).slice(0, HELP_VIEW_LIMIT);
  const shellData: ShellData = {
    platform: keyboardPlatform(c.req.raw.headers.get("User-Agent") ?? ""),
    ...(viewHelp.length ? { help: viewHelp } : {}),
    ...(layoutHelpFailed(c) ? { helpFailed: true as const } : {}),
    apps: allApps,
    ...(user
      ? {
          rail: c.get("railPreferences") ?? defaultRailPreferences(),
          home: startPagePath(settings?.app?.home_path),
          profile: { name: profileName, avatarSrc: profileAvatarSrc, appHref },
        }
      : {}),
    legalLinks,
    theme,
    accent: currentApp?.appearance?.accent,
    searchLinks,
    appId: currentApp?.id,
  };
  if (focusMode) {
    return (
      <LocaleProvider locale={lang}>
        <div
          class="cloud-app-canvas flex h-dvh w-full overflow-hidden"
          style={canvasStyle}
          data-app-id={currentApp?.id}
          data-app-base={currentRoute?.prefix}
          data-page-trail-title-only=""
          data-layout-full-page="true"
          data-workspace-sidebar-collapsed={workspaceLayout?.sidebarCollapsed ? "true" : undefined}
        >
          <ShellRuntime pageTrail help={runtimeHelp} />
          <PageTrailProvider trail={pageTrail}>
            <main class="min-h-0 min-w-0 flex-1">
              <AppWorkspace.LayoutStateProvider state={workspaceLayout}>{props.children}</AppWorkspace.LayoutStateProvider>
            </main>
          </PageTrailProvider>
          <div data-print-fallback="">
            <p>{t.printFallbackTitle}</p>
            <p>{props.printHint ?? t.printFallbackHint}</p>
          </div>
        </div>
      </LocaleProvider>
    );
  }
  // The canvas takes the window's visible height. `vh` follows the large
  // viewport, which is taller than the window while a browser shows its
  // toolbar, and would let a viewport-bound page scroll by that difference.
  return (
    <LocaleProvider locale={lang}>
      <div
        class={`cloud-app-canvas relative flex w-full ${fullPage ? "h-dvh overflow-hidden" : "min-h-dvh md:h-dvh md:overflow-hidden"}`}
        style={canvasStyle}
        data-app-id={currentApp?.id}
        data-app-base={currentRoute?.prefix}
        data-page-trail-title-only={titleOnly ? "" : undefined}
        data-layout-full-page={fullPage ? "true" : undefined}
        data-layout-authenticated={showRail ? "true" : undefined}
        data-shell-focus={shellFocus ? "true" : undefined}
        data-workspace-sidebar-collapsed={workspaceLayout?.sidebarCollapsed ? "true" : undefined}
      >
        <ShellRuntime
          workspace={{ appId: currentApp?.id }}
          pageTrail
          focus={showRail}
          help={runtimeHelp}
          commands={{ searchResources: !!user }}
          push={!!user}
          announcements={
            user && announcements?.announcements.length
              ? { entries: announcements.announcements, latestVersion: announcements.latestAnnouncementVersion }
              : undefined
          }
          banners={user && announcements?.banners.length ? true : undefined}
        />
        <ShellDataProvider data={shellData}>
          {showRail && <LayoutRail currentPath={requestPath(c)} />}
          {showRail && <ShellFocusToggle variant="float" />}
          {showRail && <div class="cloud-shell-reveal" data-cloud-shell-reveal="" aria-hidden="true" />}
          <div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col">
            <LayoutHeader
              authenticated={showRail}
              title={appLabel ?? breadcrumbs.at(-1)?.title}
              launchpad={!!(user || appLabel)}
              breadcrumbs={user ? undefined : breadcrumbs}
            />
            {user && announcements && <AnnouncementBanners banners={announcements.banners} />}
            {user && <ProfileWarnings user={user} locale={lang} />}
            {user && <ExpiryWarnings user={user} dateConfig={dateConfig} locale={lang} />}
            <PageTrailProvider trail={pageTrail}>
              <PageTrailRow trail={pageTrail} />
              <main class={`layout-content-main min-h-0 min-w-0 flex-1 ${mainLayoutClass}`}>
                <AppWorkspace.LayoutStateProvider state={workspaceLayout}>{props.children}</AppWorkspace.LayoutStateProvider>
              </main>
            </PageTrailProvider>
            {!fullPage && !showRail && <LayoutFooter appName={settings?.app?.copyright || appName} legalLinks={legalLinks} />}
          </div>
          {showRail && <LayoutTabBar currentPath={requestPath(c)} />}
        </ShellDataProvider>
        <div data-print-fallback="">
          <p>{t.printFallbackTitle}</p>
          <p>{props.printHint ?? t.printFallbackHint}</p>
        </div>
      </div>
    </LocaleProvider>
  );
}
