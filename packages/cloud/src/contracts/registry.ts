import type { HelpManifest } from "../shared/help";
import type { AppAdminNavigationGroup, AppAppearance, AppAppearanceColor, AppPresentationCatalog } from "./app";
import type { CapabilityManifest } from "./capabilities";
import type { Role } from "./shared";
import type { DashboardWidgetPresentation } from "./widgets";

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
  adminHref?: string;
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
};

export type AppRegistryHelpSummary = HelpManifest;

export type HelpRegistryDocument = {
  id: string;
  title: string;
  icon?: string;
  description?: string;
  order: number;
  markdown: string;
  /** Precomputed by the app. Older registry entries may omit it during rolling upgrades. */
  searchText?: string;
};

/** Full Markdown lives separately so normal app discovery stays small. */
export type HelpRegistryEntry = {
  appId: string;
  appName: string;
  appIcon: string;
  manifestHash: string;
  /** Base language that owns the complete logical article set. Absent on legacy registrations. */
  baseLocale?: string;
  /** Partial localized article variants stored in the same bounded logical registration. */
  documentsByLocale?: Readonly<Record<string, readonly HelpRegistryDocument[]>>;
  documents: readonly HelpRegistryDocument[];
};

export type AppRegistryLegalLink = {
  label: string;
  href: string;
  icon?: string;
};

export type AppRegistryWidget = {
  id: string;
  /** Absolute path on the app's HTTP service, e.g. "/api/quotes/widget/random". */
  path: string;
  presentation?: DashboardWidgetPresentation;
};

export type AppRuntimeMetadata = {
  release: string;
  syncVersion: string;
};

export type AppRegistryEntry = {
  id: string;
  name: string;
  icon: string;
  description: string;
  presentation?: AppPresentationCatalog;
  appearance?: AppAppearance;
  baseUrl: string;
  /** Build metadata reported by the running app. Missing on older app releases. */
  runtime?: AppRuntimeMetadata;
  /**
   * Top-level URL prefixes the gateway routes to this app. The gateway
   * builds a prefix-trie from these strings, no derivation or heuristics.
   */
  routes: readonly string[];
  nav?: AppRegistryNav;
  adminNav?: AppAdminNavigationGroup[];
  capabilities?: AppRegistryCapabilitySummary;
  help?: AppRegistryHelpSummary;
  legalLinks?: AppRegistryLegalLink[];
  widgets?: AppRegistryWidget[];
  /** Setting keys declared by this app. Used by admin tooling to avoid treating live app-owned settings as legacy. */
  settingKeys?: readonly string[];
  /** Gateway-relative URL where this app serves its OpenAPI JSON spec. */
  openapi?: string;
};
