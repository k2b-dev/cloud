/**
 * URL state for the capability execution page.
 *
 * Filtering and paging stay in the address bar so an operator can reload the
 * page or send a colleague the exact call that failed. Paging is keyset-based,
 * matching the store: the cursor travels in the URL instead of a page number.
 */
import { createUrlFilter, flag, oneOf, text, type UrlFilterField } from "@k2b/cloud/ssr/url-filter";
import type { CapabilityExecutionFilter } from "@k2b/cloud/capabilities/store";
import { z } from "zod";

export const CAPABILITIES_BASE_PATH = "/admin/observability/capabilities";

export const ORIGIN_FILTERS = ["all", "assistant", "mcp", "http", "app"] as const;
export type OriginFilter = (typeof ORIGIN_FILTERS)[number];

export const STATUS_FILTERS = ["all", "succeeded", "failed", "denied", "invalid_input", "timed_out", "rejected"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const WINDOWS = ["1h", "24h", "7d", "30d", "90d"] as const;
export type WindowFilter = (typeof WINDOWS)[number];

const WINDOW_MS: Record<WindowFilter, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

export const windowStart = (window: WindowFilter): Date => new Date(Date.now() - WINDOW_MS[window]);

const uuid = (param: string): UrlFilterField<string> => ({
  param,
  fallback: "",
  parse: (raw) => {
    const parsed = z.string().uuid().safeParse(raw);
    return parsed.success ? parsed.data : "";
  },
});

export const capabilitiesFilter = createUrlFilter(CAPABILITIES_BASE_PATH, {
  app: text("app"),
  capability: text("capability"),
  origin: oneOf<OriginFilter>("origin", ORIGIN_FILTERS, "all"),
  status: oneOf<StatusFilter>("status", STATUS_FILTERS, "all"),
  user: uuid("user"),
  destructive: flag("destructive"),
  window: oneOf<WindowFilter>("window", WINDOWS, "24h"),
  /** Opens the detail for one correlated call, keeping the list filters behind it. */
  request: text("request"),
  /** Keyset cursor from the store; opaque to the page. */
  cursor: text("cursor"),
});

export type CapabilitiesFilterState = ReturnType<typeof capabilitiesFilter.parse>;

export const EXECUTIONS_PER_PAGE = 50;

/** Translates URL state into the store filter. `all` and empty text mean "no constraint". */
export const executionFilter = (state: CapabilitiesFilterState): CapabilityExecutionFilter => ({
  ...(state.app ? { appId: state.app } : {}),
  ...(state.capability ? { capability: state.capability } : {}),
  ...(state.origin === "all" ? {} : { origin: state.origin }),
  ...(state.status === "all" ? {} : { status: state.status }),
  ...(state.user ? { userId: state.user } : {}),
  ...(state.destructive ? { destructive: true } : {}),
  since: windowStart(state.window),
});
