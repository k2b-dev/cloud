import type { HtmlFn } from "@k2b/ssr";
import type { Context } from "hono";
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";
import { PWA_AUTH_PATH, PWA_SCOPE } from "../contracts/pwa";
import { getLocale } from "../server/locale";
import { preloadLayoutAnnouncements } from "../server/middleware/settings";
import { createLoginRedirectUrl } from "../shared/redirect";
import type { PageOptions } from "./define-app";

export type PageErrorOptions = {
  title?: string;
  description?: string;
  action?: { label: string; href: string; icon?: string };
  /** Keep standalone/public pages outside the Cloud navigation shell; `pwa` renders a page of the mobile app. */
  layout?: "cloud" | "minimal" | "pwa";
};

export type PageErrorStatus = ClientErrorStatusCode | ServerErrorStatusCode;

/** Explicit document responses, bound to the owning application's SSR template. */
export const createPageResponses = (html: HtmlFn<PageOptions>) => {
  const error = async (c: Context, status: PageErrorStatus, options: PageErrorOptions = {}): Promise<Response> => {
    // Auth middleware may reject before ssr() initializes page metadata.
    c.set("page", { lang: getLocale(c) });
    c.header("Cache-Control", "private, no-store");
    if (options.layout !== "pwa") await preloadLayoutAnnouncements(c);
    // Load JSX only after the application's SSR plugin has been installed.
    const { renderPageError } = await import("../ssr/PageError");
    const response = await html(renderPageError(c, status, options), c.get("page"));
    return c.newResponse(response.body, { status, headers: response.headers });
  };

  const access = {
    onReject: (c: Context, reason: "unauthenticated" | "forbidden") => {
      c.header("Cache-Control", "private, no-store");
      // Account policies can reject a resolved non-user actor as unauthenticated.
      // A browser page must not send that actor into a login/return loop.
      return reason === "unauthenticated" && !c.get("actor") ? createLoginRedirectUrl(c.req.url) : error(c, 403);
    },
  };

  /**
   * Route policy for pages of the mobile app (preview), below `/pwa/`. Only an app session reaches them. Without
   * one, Core renews the app session with the phone's device key and returns to the same page; `pwa_launch` marks
   * that return, so a second miss stops at the shell's "unavailable" state instead of bouncing again.
   */
  const pwaAccess = {
    onReject: (c: Context, reason: "unauthenticated" | "forbidden") => {
      c.header("Cache-Control", "private, no-store");
      if (reason === "forbidden" || c.get("actor")) return error(c, 403, { layout: "pwa" });
      const url = new URL(c.req.url);
      if (url.searchParams.has("pwa_launch")) return `${PWA_SCOPE}?pwa=unavailable`;
      return `${PWA_AUTH_PATH}/session/launch?to=${encodeURIComponent(url.pathname + url.search)}`;
    },
  };

  return { access, pwaAccess, error };
};
