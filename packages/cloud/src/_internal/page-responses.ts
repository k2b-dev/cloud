import type { HtmlFn } from "@k2b/ssr";
import type { Context } from "hono";
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";
import { getLocale } from "../server/locale";
import { createLoginRedirectUrl } from "../shared/redirect";
import type { PageOptions } from "./define-app";

export type PageErrorOptions = {
  title?: string;
  description?: string;
  action?: { label: string; href: string; icon?: string };
  /** Keep standalone/public pages outside the Cloud navigation shell. */
  layout?: "cloud" | "minimal";
};

export type PageErrorStatus = ClientErrorStatusCode | ServerErrorStatusCode;

/** Explicit document responses, bound to the owning application's SSR template. */
export const createPageResponses = (html: HtmlFn<PageOptions>) => {
  const error = async (c: Context, status: PageErrorStatus, options: PageErrorOptions = {}): Promise<Response> => {
    // Auth middleware may reject before ssr() initializes page metadata.
    c.set("page", { lang: getLocale(c) });
    c.header("Cache-Control", "private, no-store");
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

  return { access, error };
};
