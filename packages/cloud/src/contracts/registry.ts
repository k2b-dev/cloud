import type { AppAdminNavigationGroup, AppAppearance, AppAppearanceColor, AppPresentationCatalog, AppSearchLink } from "./app";
import type { CapabilityManifest, CapabilityPresentationCatalog } from "./capabilities";
import type { PlatformPermission } from "./outgoing-mail";
import type { Role } from "./shared";
import type { DashboardWidgetPresentation, DashboardWidgetSize } from "./widgets";

/**
 * App-registry entry type. Populated internally by `defineApp()` + the
 * heartbeat runtime. Values are validated when read because Redis may still
 * contain records written by older or interrupted runtimes.
 */

export type AppRegistryNav = {
  href: string;
  match?: string;
  section: "primary" | "more" | "hidden";
  requiresAuth?: boolean;
  requiresRoles?: Role[];
  badge?: string;
  adminHref?: string;
};

export type AppRegistryPwaPart = {
  href: string;
  requiresRoles?: Role[];
};

export type AppRegistryCapabilitySummary = {
  protocolVersion: number;
  manifestHash: string;
};

/** Validated Capability manifest joined to its matching live app lease. */
export type CapabilityRegistryEntry = {
  appId: string;
  appName: string;
  appIcon: string;
  appAccent?: AppAppearanceColor;
  appDescription: string;
  endpoint: string;
  manifest: CapabilityManifest;
  presentation?: CapabilityPresentationCatalog;
  /** The app's own name and description overlays, so capability consumers can present the app in the reader's locale. */
  appPresentation?: AppPresentationCatalog;
};

export type AppRegistryHelpSummary = { manifestHash: string; pageBase: string; baseLocale: string };

export type AppRegistryLegalLink = {
  label: string;
  href: string;
  icon?: string;
};

/** A widget declaration as the registry carries it; see `WidgetEndpoint`. Older apps send only `id` and `path`. */
export type AppRegistryWidget = {
  id: string;
  /** Absolute path on the app's HTTP service, e.g. "/api/quotes/widget/random". */
  path: string;
  title?: string;
  description?: string;
  sizes?: readonly DashboardWidgetSize[];
  defaultSize?: DashboardWidgetSize;
  suggest?: boolean;
  requiresRoles?: readonly Role[];
  /** @deprecated Ignored by the dashboard. */
  presentation?: DashboardWidgetPresentation;
};

export type AppRuntimeMetadata = {
  /** Cloud version of the running app. Missing on apps built before versions were baked in. */
  version?: string;
  release: string;
  syncVersion: string;
};

export type AppRegistryEntry = {
  platformPermissions?: readonly PlatformPermission[];
  id: string;
  name: string;
  icon: string;
  description: string;
  presentation?: AppPresentationCatalog;
  appearance?: AppAppearance;
  baseUrl: string;
  /** Build metadata reported by the running app. Missing on older app releases. */
  runtime?: AppRuntimeMetadata;
  /** Process start time (epoch ms) reported by the running app; the registry cannot know it. */
  startedAt?: number;
  /**
   * Top-level URL prefixes the gateway routes to this app. The gateway
   * builds a prefix-trie from these strings, no derivation or heuristics.
   */
  routes: readonly string[];
  nav?: AppRegistryNav;
  adminNav?: AppAdminNavigationGroup[];
  capabilities?: AppRegistryCapabilitySummary;
  help?: AppRegistryHelpSummary;
  skills?: { manifestHash: string };
  legalLinks?: AppRegistryLegalLink[];
  searchLinks?: readonly AppSearchLink[];
  /** The app's part of the mobile app (preview); `href` is `/pwa/<id>`. Older readers ignore it. */
  pwa?: AppRegistryPwaPart;
  widgets?: AppRegistryWidget[];
  /** Setting keys declared by this app. Used by admin tooling to avoid treating live app-owned settings as legacy. */
  settingKeys?: readonly string[];
  /** Gateway-relative URL where this app serves its OpenAPI JSON spec. */
  openapi?: string;
  /** Names of the `cld` modules this app serves under `/cli/plugins/<name>`. */
  cliModules?: readonly string[];
};
