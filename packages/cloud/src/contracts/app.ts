import type { HelpManifest } from "../shared/help";
import type { Role } from "./shared";
import type { DashboardWidgetPresentation } from "./widgets";

/**
 * One link entry contributed by an app to the global legal/info footer
 * (login page, app footer, rail dropdown). Aggregated across all running
 * apps via `listLegalLinks()`.
 */
export type LegalLink = {
  label: string;
  href: string;
  icon?: string;
};

export type AppAppearanceColor = `#${string}`;

export type AppAppearance = {
  accent: AppAppearanceColor;
  background?: {
    from: AppAppearanceColor;
    via?: AppAppearanceColor;
    to?: AppAppearanceColor;
    angle?: number;
    /** Edge color intensity from 0 to 100. Defaults to 20. */
    strength?: number;
  };
};

export type AppAdminNavigationLink = {
  label: string;
  href: string;
  icon: string;
};

export type AppAdminNavigationGroup = {
  /** Stable key used only to localize this presentation group. */
  id?: string;
  label: string;
  links: AppAdminNavigationLink[];
};

export type AppPresentationTranslation = {
  name?: string;
  description?: string;
  /** Group labels keyed by `adminNav[].id`. */
  adminGroups?: Readonly<Record<string, string>>;
  /** Link labels keyed by their stable same-origin href. */
  adminLinks?: Readonly<Record<string, string>>;
  /** Legal-link labels keyed by their stable same-origin href. */
  legalLinks?: Readonly<Record<string, string>>;
};

export type AppPresentationCatalog = {
  /** Locale of the complete `name`, `description`, `adminNav`, and `legalLinks` declaration. */
  baseLocale: string;
  /** Partial presentation overlays with exact -> ancestor -> base fallback. */
  translations: Readonly<Record<string, AppPresentationTranslation>>;
};

export type AppMeta = {
  id: string;
  name: string;
  icon: string;
  description: string;
  presentation?: AppPresentationCatalog;
  appearance?: AppAppearance;
  adminHref?: string;
  /** Optional multi-link admin navigation owned by this app. */
  adminNav?: AppAdminNavigationGroup[];
  /**
   * Top-level URL prefixes the gateway routes to this app. The gateway
   * is dumb — it just builds a prefix-trie from these strings.
   */
  routes: readonly string[];
  nav?: {
    href: string;
    match?: string;
    section: "primary" | "more" | "hidden";
    requiresAuth?: boolean;
    requiresRoles?: Role[];
  };
  /**
   * Legal/info pages this app owns. Aggregated app-wide and rendered in
   * login footer, app Footer, and the rail "more" dropdown. Each app
   * contributes its own (e.g. settings → terms/privacy/imprint, faq → FAQ).
   */
  legalLinks?: LegalLink[];
  /**
   * Dashboard widget endpoints this app exposes. Each entry references an
   * HTTP endpoint that returns a `WidgetResponse` (see `contracts/widgets.ts`).
   * Core resolves the initiating user before dispatching these; the endpoint
   * is responsible for permission / role gating and returns 204 to silently
   * skip rendering for the current user.
   */
  widgets?: WidgetEndpoint[];
  /** Setting keys declared by this app. Used by admin tooling to protect active app-owned settings. */
  settingKeys?: readonly string[];
  /** Gateway-relative URL where this app's OpenAPI JSON is served, or undefined. */
  openapi?: string;
};

export type WidgetEndpoint = {
  /** Unique-within-the-app id, e.g. "open-requests". */
  id: string;
  /** Absolute path on the app's HTTP service, e.g. "/api/accounts/widget/open-requests". */
  path: string;
  /** Optional initial layout recommendation. Explicit user choices win. */
  presentation?: DashboardWidgetPresentation;
};

export type RuntimeAppMeta = AppMeta & {
  help?: HelpManifest;
  searchTags?: string[];
  searchHelp?: string;
  searchTagHelp?: AppSearchTagHelpEntry[];
};

export type CloudLogger = {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export type CloudRuntime = {
  apps: readonly RuntimeAppMeta[];
};

export type CloudContext = {
  logger: (source: string) => CloudLogger;
  settings: {
    get: <T = unknown>(key: string) => Promise<T>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  runtime: CloudRuntime;
};

export type CloudLifecycleContext = CloudContext;

export type AppLifecycle = {
  setup?: (ctx: CloudContext) => Promise<void>;
  start?: (ctx: CloudContext) => Promise<void>;
  stop?: (ctx: CloudContext) => Promise<void>;
};

export type AppSearchTagHelpEntry = {
  tag: string;
  help: string;
};

/**
 * Removes query parameters from a navigation href so path matching stays stable.
 */
export const stripQuery = (href: string): string => href.split("?")[0] ?? href;

/**
 * Resolves the active-path matcher for a nav entry.
 */
export const resolveNavMatch = (meta: AppMeta): string | undefined => meta.nav?.match ?? (meta.nav ? stripQuery(meta.nav.href) : undefined);
