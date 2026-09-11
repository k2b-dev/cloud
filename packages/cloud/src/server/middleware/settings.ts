/**
 * Per-request middleware that exposes a frozen settings snapshot on
 * `c.get("settings")`. Backed by Redis cache-aside (5-minute TTL),
 * so the per-request cost is a single Redis read at most.
 *
 * Required by anything that reads typed settings inside an HTTP
 * handler via `c.get("settings").<key>`.
 *
 * `skipPrefixes` defaults to `["/public/", "/_ssr/", "/branding/", "/favicon"]`
 * — those paths never read settings, so skipping the snapshot load
 * keeps static-asset requests free. Apps that mount settings only on
 * /api or /app can avoid the option entirely by scoping the
 * `.use()` path instead.
 */
import { createMiddleware } from "hono/factory";
import {
  type ActiveAnnouncementsResponse,
  type AnnouncementCookieState,
  parseAnnouncementCookieHeader,
} from "../../contracts/announcements";
import { announcements } from "../../services/announcements";
import { logger } from "../../services/logging";
import { loadSnapshot } from "../../services/settings/snapshot";

const DEFAULT_SKIP = ["/public/", "/_ssr/", "/branding/", "/favicon"] as const;
const ANNOUNCEMENT_SKIP = ["/api/", "/public/", "/_ssr/", "/branding/", "/favicon"] as const;
const log = logger("middleware:settings");

export type LayoutAnnouncementsState = ActiveAnnouncementsResponse & {
  cookieState: AnnouncementCookieState;
};

const shouldLoadAnnouncements = (path: string, cookieHeader: string | null): boolean =>
  Boolean(cookieHeader?.match(/(?:^|;\s*)session_token=/)) && !ANNOUNCEMENT_SKIP.some((prefix) => path.startsWith(prefix));

export const settings = (opts?: { skipPrefixes?: readonly string[] }) => {
  const skip = opts?.skipPrefixes ?? DEFAULT_SKIP;
  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    if (!skip.some((p) => path.startsWith(p))) {
      (c as unknown as { set: (k: string, v: unknown) => void }).set("settings", await loadSnapshot());
    }
    await next();
  });
};

/** Called by SSR finalization, after redirects and non-HTML responses are known. */
export const preloadLayoutAnnouncements = async (c: import("hono").Context): Promise<void> => {
  const path = c.req.path;
  const cookieHeader = c.req.header("Cookie") ?? null;
  if (shouldLoadAnnouncements(path, cookieHeader)) {
    const cookieState = parseAnnouncementCookieHeader(cookieHeader);
    try {
      const active = await announcements.active.forState({ state: cookieState });
      (c as unknown as { set: (k: string, v: unknown) => void }).set("announcements", { ...active, cookieState });
    } catch (error) {
      log.warn("Failed to preload announcements", { error: error instanceof Error ? error.message : String(error) });
    }
  }
};
