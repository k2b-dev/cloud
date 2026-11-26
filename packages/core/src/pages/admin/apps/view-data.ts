import type { AppAccessEditorProps } from "@k2b/cloud/access/ui";
import type { AppDetails } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import type { DomainsProps } from "./Domains";
import type { AppDomainEntry } from "./domains-model";
import type { KeysProps } from "./Keys";
import type { AppEntry, AppStatusWindow, AppsQuery } from "./model";

// What the Apps page reads on the server and hands to its screen: plain data, worded in the browser with the same clock.

export type AppPageData = {
  entry: AppEntry;
  /** Null when Core could not read events and notifications; access and keys stay usable. */
  details: AppDetails | null;
  /** Name of the newest revoked key, for the "key revoked" hint. */
  revokedKeyName: string | null;
  /**
   * Whether a key exists that Core would take at the next start: active and not the refused one (for a refusal while
   * background access was off, any active key). Null when the keys could not be read; counts then stand in.
   */
  startKeyReady: boolean | null;
  /** Providers that did not answer for this app. */
  providerFailures: readonly string[];
  /** The app's access rule as one phrase, for a rule the app fixes itself. */
  accessRule: string;
  /** Core and Gateway are platform services and have no app keys. */
  keysSupported: boolean;
  /** The domains of an app with public pages; null for an app without them, which has no Domains row. */
  domains: readonly AppDomainEntry[] | "failed" | null;
  /** Fibel pages for the key hints: recovering a key and switching from the environment to a key. */
  docs: { recover: string | null; migrate: string | null };
  /** Display names of known apps by ID, for publishers of heard events. */
  appNames: ReadonlyMap<string, string>;
};

export type RouteRow = {
  prefix: string;
  requests: number | null;
  errors: number | null;
  router: "active" | "missing" | "unknown";
  owner: string | null;
};

export type DetailData =
  | { view: "access"; rule: string; editor: AppAccessEditorProps | null }
  | { view: "keys"; keys: KeysProps }
  | { view: "domains"; domains: DomainsProps }
  | { view: "events" }
  | {
      view: "routes";
      window: AppStatusWindow;
      /** One table per provider that answered, each with its own source line; one table without numbers if none did. */
      tables: ReadonlyArray<{ provider: string | null; rows: readonly RouteRow[] }>;
      failures: readonly string[];
      routerKnown: boolean;
      avgMs: number | null;
      telemetryHref: string | null;
      routesHref: string | null;
    }
  | {
      view: "runtime";
      release: string | null;
      build: string | null;
      sync: string | null;
      baseUrl: string | null;
      heartbeatAt: string | null;
      startedAt: string | null;
      issues: ReadonlyArray<{ severity: "warn" | "error"; message: string }>;
      instances: ReadonlyArray<{ hostname: string; startedAt: string; via: "key" | "env" | "unknown"; keyName: string | null }>;
      inRail: boolean;
      adminHref: string | null;
      capabilities: number | null;
      capabilitiesHref: string | null;
    }
  | {
      view: "errors";
      /** Each provider's failed requests under its own name: at most one page each, the rest in its telemetry. */
      groups: ReadonlyArray<{
        provider: string;
        failedRequests: ReadonlyArray<{ at: string; method: string; path: string; status: number }>;
        total: number | null;
      }>;
      failures: readonly string[];
      telemetryHref: string | null;
      logsHref: string | null;
    };

export type AppsViewData = {
  locale: string;
  /** The reader's date settings and the moment the server rendered, so the browser words every time alike. */
  dateConfig: DateContext;
  now: number;
  query: AppsQuery;
  list:
    | { state: "failed" }
    | {
        state: "ok";
        apps: readonly AppEntry[];
        issues: ReadonlyArray<{ key: string; reason: string }>;
        unchecked: number;
        logsHref: string | null;
      };
  app: AppPageData | null;
  detail: DetailData | null;
};
