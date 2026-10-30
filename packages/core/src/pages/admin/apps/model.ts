/**
 * What the Apps page shows about each app, derived from the platform's own reads: the live registry, what Core
 * remembers, Core's facts (access, keys, deliveries), the router's state and the numbers of `app-status` providers.
 * Pure, so the list, the app page and their tests agree on one status and one set of hints.
 */

export type AppStatusKind = "ok" | "warn" | "error" | "idle";

/** The level-3 columns a row or hint opens; `remove` opens the confirmation instead. */
export type AppView = "access" | "keys" | "events" | "routes" | "runtime" | "errors";
export type HintTarget = AppView | "remove";

export type AppHint =
  | { kind: "notRunning"; since: string | null }
  | { kind: "providerOnly"; provider: string; lastSeenAt: string | null }
  | { kind: "neverStarted"; hasKey: boolean }
  | { kind: "keyRevoked" }
  | { kind: "errorRate"; rate: number }
  | { kind: "failedDeliveries"; count: number }
  | { kind: "routeMissing"; prefix: string; owner: string | null }
  | { kind: "accessUnmanaged" }
  | { kind: "runtime"; severity: "warn" | "error"; message: string };

export const HINT_PRESENTATION: Record<AppHint["kind"], { tone: "neutral" | "warning" | "danger"; icon: string; target: HintTarget }> = {
  notRunning: { tone: "danger", icon: "ti ti-plug-connected-x", target: "errors" },
  providerOnly: { tone: "warning", icon: "ti ti-git-compare", target: "remove" },
  neverStarted: { tone: "neutral", icon: "ti ti-info-circle", target: "keys" },
  keyRevoked: { tone: "danger", icon: "ti ti-key-off", target: "keys" },
  errorRate: { tone: "warning", icon: "ti ti-alert-triangle", target: "errors" },
  failedDeliveries: { tone: "danger", icon: "ti ti-alert-circle", target: "events" },
  routeMissing: { tone: "warning", icon: "ti ti-route-off", target: "routes" },
  accessUnmanaged: { tone: "warning", icon: "ti ti-lock-exclamation", target: "access" },
  runtime: { tone: "warning", icon: "ti ti-alert-triangle", target: "runtime" },
};

/** Numbers of one provider for one app. `traffic: null` means the provider has no measurements, not 0 requests. */
export type ProviderNumbers = {
  provider: { appId: string; name: string };
  traffic: { requests: number; errors: number; avgMs: number | null } | null;
  /** `kind` says what a link opens, so the page can place it; links without a kind stay in "More". */
  links: Array<{ label: string; href: string; kind?: "logs" | "metrics" | "routes" | "capabilities" }>;
  lastSeenAt: string | null;
};

/** One app as the page's inputs describe it, before any derivation. */
export type AppInput = {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string | null;
  /** In the live registry right now. */
  live: boolean;
  /** The heartbeat expires within 30 s although the app is live. */
  heartbeatStale: boolean;
  release: string | null;
  routes: readonly string[];
  adminHref: string | null;
  /** A provider's link to the app's logs, for the row menu. */
  logsHref: string | null;
  instances: number | null;
  /** Core's memory of the app: when it first and last saw it in the registry. */
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** The earliest record Core holds for the app (key, token, access), for an app that never ran. */
  firstKnownAt: string | null;
  /** True when Core has any record of the app (memory, keys, tokens, access). */
  coreKnows: boolean;
  accessKind: "grants" | "signedIn" | "noGuests" | "roles" | "resources" | "legacy" | null;
  access: { people: number; groups: number; serviceAccounts: number; managers: number } | null;
  keys: { active: number; expired: number; revoked: number; lastUsedAt: string | null; accountStatus: "active" | "disabled" | null };
  failedDeliveries: number;
  /** A rejected registry entry or a runtime incompatibility of this app. */
  runtimeIssues: ReadonlyArray<{ severity: "warn" | "error"; message: string }>;
  /** Declared prefixes the router does not send to this app; null owner means no app gets it. Empty without a router state. */
  missingRoutes: ReadonlyArray<{ prefix: string; owner: string | null }>;
  numbers: readonly ProviderNumbers[];
  /** Providers that should have reported this app but did not answer in time or at all. */
  numbersUnavailable: boolean;
};

export type AppEntry = AppInput & { status: AppStatusKind; hints: AppHint[]; neverStarted: boolean; removable: boolean };

/** A share of failed requests from which an app counts as disturbed; below `ERROR_RATE_MIN_REQUESTS` the share says little. */
export const ERROR_RATE_WARN = 0.01;
export const ERROR_RATE_MIN_REQUESTS = 20;

const errorRate = (numbers: readonly ProviderNumbers[]): number | null => {
  let requests = 0;
  let errors = 0;
  for (const entry of numbers) {
    if (!entry.traffic) continue;
    requests = Math.max(requests, entry.traffic.requests);
    errors = Math.max(errors, entry.traffic.errors);
  }
  return requests >= ERROR_RATE_MIN_REQUESTS ? errors / requests : null;
};

/** The provider's latest sighting of an app that Core never saw run. */
const providerSighting = (input: AppInput) =>
  input.numbers.filter((entry) => entry.lastSeenAt).toSorted((a, b) => Date.parse(b.lastSeenAt!) - Date.parse(a.lastSeenAt!))[0];

export function deriveApp(input: AppInput): AppEntry {
  const sighting = providerSighting(input);
  const lastSeen = input.lastSeenAt ?? sighting?.lastSeenAt ?? null;
  const neverStarted = !input.live && !lastSeen;
  const providerOnly = !input.live && !input.coreKnows && sighting;
  const rate = input.live ? errorRate(input.numbers) : null;
  const hints: AppHint[] = [];
  if (providerOnly) hints.push({ kind: "providerOnly", provider: sighting.provider.name, lastSeenAt: sighting.lastSeenAt });
  else if (neverStarted) hints.push({ kind: "neverStarted", hasKey: input.keys.active > 0 });
  else if (!input.live) hints.push({ kind: "notRunning", since: lastSeen });
  for (const issue of input.runtimeIssues) hints.push({ kind: "runtime", severity: issue.severity, message: issue.message });
  if (rate !== null && rate >= ERROR_RATE_WARN) hints.push({ kind: "errorRate", rate });
  if (input.failedDeliveries > 0) hints.push({ kind: "failedDeliveries", count: input.failedDeliveries });
  if (input.live) for (const route of input.missingRoutes) hints.push({ kind: "routeMissing", ...route });
  if (input.keys.active === 0 && input.keys.revoked + input.keys.expired > 0) hints.push({ kind: "keyRevoked" });
  if (input.live && input.accessKind === "grants" && input.access && input.access.managers === 0) hints.push({ kind: "accessUnmanaged" });
  const status: AppStatusKind = neverStarted
    ? "idle"
    : !input.live || input.runtimeIssues.some((issue) => issue.severity === "error")
      ? "error"
      : input.heartbeatStale ||
          input.runtimeIssues.length > 0 ||
          (rate !== null && rate >= ERROR_RATE_WARN) ||
          input.missingRoutes.length > 0
        ? "warn"
        : "ok";
  // Most severe first: what keeps the app from working, then what fails now, then what to fix next.
  const order: AppHint["kind"][] = [
    "providerOnly",
    "notRunning",
    "neverStarted",
    "runtime",
    "keyRevoked",
    "errorRate",
    "failedDeliveries",
    "routeMissing",
    "accessUnmanaged",
  ];
  hints.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { ...input, lastSeenAt: lastSeen, status, hints, neverStarted, removable: !input.live };
}

/** Sorted by name, so a new hint never moves a row. */
export const sortApps = (apps: readonly AppEntry[], locale: string): AppEntry[] =>
  apps.toSorted((a, b) => a.name.localeCompare(b.name, locale) || a.id.localeCompare(b.id));

export const countStatuses = (apps: readonly AppEntry[]): Record<AppStatusKind, number> => {
  const counts: Record<AppStatusKind, number> = { ok: 0, warn: 0, error: 0, idle: 0 };
  for (const app of apps) counts[app.status] += 1;
  return counts;
};

/** "/mail, /api/mail +2": the first two prefixes and how many more. */
export const routeSummary = (routes: readonly string[]): { shown: string; more: number } => ({
  shown: routes.slice(0, 2).join(", "),
  more: Math.max(0, routes.length - 2),
});

const VIEWS: readonly AppView[] = ["access", "keys", "events", "routes", "runtime", "errors"];
export const WINDOWS = ["1h", "6h", "24h", "7d", "30d"] as const;
export type AppStatusWindow = (typeof WINDOWS)[number];
export type MovedFrom = "gateway" | "credentials";

/** The page's URL state. `traffic` is the old name of the routes column and opens it. */
export function parseAppsQuery(query: Record<string, string | undefined>) {
  const app = query.app && /^[a-z][a-z0-9-]{0,79}$/.test(query.app) ? query.app : null;
  const requested = query.view === "traffic" ? "routes" : query.view;
  const view = app && VIEWS.includes(requested as AppView) ? (requested as AppView) : null;
  const window = WINDOWS.includes(query.window as AppStatusWindow) ? (query.window as AppStatusWindow) : "24h";
  const moved = query.moved === "gateway" || query.moved === "credentials" ? (query.moved as MovedFrom) : null;
  return { app, invalidApp: Boolean(query.app) && !app, view, window, moved };
}
export type AppsQuery = ReturnType<typeof parseAppsQuery>;

export function appsHref(query: { app?: string | null; view?: AppView | null; window?: AppStatusWindow | null }): string {
  const params = new URLSearchParams();
  if (query.app) params.set("app", query.app);
  if (query.app && query.view) params.set("view", query.view);
  if (query.app && query.view === "routes" && query.window && query.window !== "24h") params.set("window", query.window);
  const search = params.toString();
  return search ? `/admin/apps?${search}` : "/admin/apps";
}
