import { ssr } from "../config";
import { join } from "node:path";
import { type AuthContext, auth } from "@k2b/cloud/server";
import { authFlows, coreSettings, legalConsent } from "@k2b/cloud/services";
import { getRuntimeContext, hasDedicatedRuntimeRoute } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import cliInstaller from "../../../cloud-cli/scripts/install.sh" with { type: "text" };
import browserNotificationServiceWorker from "../browser-notifications/service-worker.js" with { type: "text" };
import announcementsAdminPage from "./admin/announcements/page";
import adminPage from "./admin/page";
import settingsPage from "./admin/settings/page";
import pairDevicePage from "./app-approval/pair.page";
import { afterSignInHref, isReauthenticationRequest, resolveAuthenticatedLoginRedirect } from "./auth/login-redirect";
import consentPage from "./auth/consent.page";
import newPasswordPage from "./auth/new-password/page";
import loginPage from "./auth/page";
import passwordResetPage from "./auth/password-reset/page";
import registeredHelpPage from "./help/registered.page";
import { resolveHomePath } from "./home";
import { makeLegalPage } from "./legal/page-handler";
import accessPage from "./me/access.page";
import developerPage from "./me/developer.page";
import notificationHistoryPage from "./me/notification-history.page";
import notificationsPage from "./me/notifications.page";
import profilePage from "./me/page";
import personalProfilePage from "./me/profile.page";
import securityPage from "./me/security.page";
import notFoundPage from "./NotFound";

/**
 * Creates the SSR pages router.
 * App pages are served by individual containers (microservices mode).
 */
export const createPagesRouter = (options?: { brandingPublicDir?: string }): Hono<AuthContext> => {
  const brandingPublicDir = options?.brandingPublicDir ?? "public";
  const pages = new Hono<AuthContext>()
    // Prevent browser from caching SSR pages (user state changes on login/logout)
    // Skip for branding assets — they set their own cache headers
    .use("*", async (c, next) => {
      await next();
      if (c.req.path.startsWith("/branding/")) return;
      c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      c.header("Pragma", "no-cache");
      c.header("Expires", "0");
    })
    // Root remains Core-owned while the configured app controls the landing page.
    .get("/", auth.requireRole("authenticated", ssr.access), async (c) => {
      const configured = await coreSettings.get<string>("app.home_path");
      return c.redirect(resolveHomePath(configured), 302);
    })
    .get("/help/apps/:appId", auth.requireRole("*"), ...registeredHelpPage)
    .get("/help/apps/:appId/:topic", auth.requireRole("*"), ...registeredHelpPage)
    // Serve the installer from the currently deployed Core bundle, rather than
    // piping a mutable branch artifact into a user's shell.
    .get("/cli", (c) => c.body(cliInstaller, 200, { "Content-Type": "text/x-shellscript; charset=utf-8" }))
    .get("/service-worker.js", (c) =>
      c.body(browserNotificationServiceWorker, 200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
        "Service-Worker-Allowed": "/",
      }),
    )
    // Profile
    .get("/me", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...profilePage)
    .get("/me/profile", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...personalProfilePage)
    .get("/me/security", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...securityPage)
    .get("/me/security/pair", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...pairDevicePage)
    .get("/me/access", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...accessPage)
    .get("/me/notifications", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...notificationsPage)
    .get(
      "/me/notifications/history",
      auth.requireRole("authenticated", ssr.access),
      auth.requireUser(ssr.access),
      ...notificationHistoryPage,
    )
    .get("/me/developer", auth.requireRole("authenticated", ssr.access), auth.requireUser(ssr.access), ...developerPage)
    // Admin pages (admin only)
    .get("/admin", auth.requireRole("admin", ssr.access), ...adminPage)
    .get("/admin/announcements", auth.requireRole("admin", ssr.access), ...announcementsAdminPage)
    .get("/admin/settings", auth.requireRole("admin", ssr.access), ...settingsPage)
    // Keep legacy admin entry points useful when their optional UI apps are absent.
    .get("/admin/apps", auth.requireRole("admin", ssr.access), (c) => {
      const apps = getRuntimeContext(c).apps;
      return c.redirect(hasDedicatedRuntimeRoute(apps, "/admin/gateway", "core") ? "/admin/gateway" : "/admin", 302);
    })
    .get("/admin/sync", auth.requireRole("admin", ssr.access), (c) => {
      const apps = getRuntimeContext(c).apps;
      return c.redirect(
        hasDedicatedRuntimeRoute(apps, "/app/accounts", "core") ? "/app/accounts#sync-activity" : "/admin/settings?tab=freeipa",
        302,
      );
    })
    // Auth routes
    .get("/auth/continue", ...consentPage)
    .get(
      "/auth/login",
      async (c, next) => {
        if (!c.req.query("token") && await legalConsent.pending(c)) return c.redirect(afterSignInHref(c.req.query("redirectTo")), 302);
        return next();
      },
      (c, next) =>
        isReauthenticationRequest(c.req.url)
          ? next()
          : auth.requireRole("anonymous", { onReject: (c) => resolveAuthenticatedLoginRedirect(c.req.url) })(c, next),
      ...loginPage,
    )
    .get("/auth/new-password", ...newPasswordPage)
    .get("/auth/password-reset", auth.requireRole("anonymous", auth.redirect("/")), ...passwordResetPage)
    .get("/auth/proxy-return", auth.requireRole("authenticated", ssr.access), async (c) => {
      const token = c.req.query("token");
      const target = token ? await authFlows.proxyReturn.consume({ token }) : null;
      return c.redirect(target?.url ?? "/", 302);
    })
    .get("/auth/extend", auth.requireRole("authenticated", ssr.access), async (c) => {
      return c.redirect("/me?action=extend", 302);
    })
    // Legal pages are driven by the `legal.*` settings group.
    .get("/legal/terms", auth.requireRole("*"), ...makeLegalPage("terms"))
    .get("/legal/privacy", auth.requireRole("*"), ...makeLegalPage("privacy"))
    .get("/impressum", auth.requireRole("*"), ...makeLegalPage("imprint"))
    // Branding assets (public, no auth, cached)
    .get("/branding/logo", async (c) => {
      return serveBranding(c, "app.logo", join(brandingPublicDir, "logo.svg"), "image/svg+xml");
    })
    .get("/branding/favicon", async (c) => {
      // Default favicon = same SVG as the logo. User-uploaded favicons come
      // through as data URIs and override this fallback (mime taken from the
      // data URI, so PNG/ICO uploads still work).
      return serveBranding(c, "app.favicon", join(brandingPublicDir, "logo.svg"), "image/svg+xml");
    });

  // 404 catch-all (must be after all mounted routes)
  pages.get("/*", auth.requireRole("*"), ...notFoundPage);
  return pages;
};

/** Serve a branding asset from settings (base64 data URI) or fall back to a static file. */
async function serveBranding(c: import("hono").Context, settingKey: string, fallbackPath: string, fallbackMime: string): Promise<Response> {
  const dataUri = await coreSettings.get<string>(settingKey);

  if (dataUri) {
    // Parse data URI: data:<mime>;base64,<data>
    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mime = match[1]!;
      const binary = Buffer.from(match[2]!, "base64");
      c.header("Content-Type", mime);
      c.header("Cache-Control", "public, max-age=3600");
      return c.body(binary);
    }
  }

  // Fallback: serve static file
  const file = Bun.file(fallbackPath);
  if (await file.exists()) {
    c.header("Content-Type", fallbackMime);
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(await file.arrayBuffer());
  }

  return c.notFound();
}
