/**
 * The capability console's one declaration: window, app, capability, origin, status, one user and destructive calls.
 * The SSR page reads the address only through it; the parameters keep the names of the page before v2, so its links
 * still read. Paging is keyset-based like the store: the cursor travels in the address.
 */
import type { CapabilityExecutionFilter } from "@k2b/cloud/capabilities/store";
import { defineListQuery, field, type ListQueryIssue, type ListQueryStateOf, type LookupItem } from "@k2b/ui/v2/list-query";
import { ORIGIN_FILTERS, STATUS_FILTERS, WINDOW_MS, WINDOWS, type WindowFilter } from "./filters";
import { capabilityOpsMessages } from "./ops-messages";

export const CAPABILITIES_PATH = "/admin/observability/capabilities";
export const EXECUTIONS_PER_PAGE = 50;

// the API's own lists (`filters.ts`), without its "all"
const CAPABILITY_WINDOWS = WINDOWS;
type CapabilityWindow = WindowFilter;
const CAPABILITY_ORIGINS = ORIGIN_FILTERS.filter((value) => value !== "all");
const CAPABILITY_STATUSES = STATUS_FILTERS.filter((value) => value !== "all");

/** The views of the console: the calls, and the busiest apps and capabilities of the window. */
export const CAPABILITY_TABS = ["executions", "apps", "capabilities"] as const;
export type CapabilityTab = (typeof CAPABILITY_TABS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asItems = async (values: readonly string[]): Promise<readonly LookupItem[]> => values.map((value) => ({ value, label: value }));

/**
 * `apps` and `capabilities` are the window's own (the filter offers what was called); the ones an address names stay
 * offered, so a link to an app without calls in the window reads as itself.
 */
export const capabilitiesQuery = (
  locale: string,
  scope: { apps: readonly string[]; capabilities: readonly string[] } = { apps: [], capabilities: [] },
  named: { app?: string | null; capability?: string | null } = {},
) => {
  const { t } = capabilityOpsMessages.resolve([locale]);
  const windowLabel: Record<CapabilityWindow, string> = { "1h": "1 h", "24h": "24 h", "7d": "7 d", "30d": "30 d", "90d": "90 d" };
  const originLabel = { assistant: t.originAssistant, mcp: t.originMcp, http: t.originHttp, app: t.originApp, choice: t.originChoice };
  const statusLabel = {
    succeeded: t.statusSucceeded,
    failed: t.statusFailed,
    denied: t.statusDenied,
    invalid_input: t.statusInvalidInput,
    timed_out: t.statusTimedOut,
    rejected: t.statusRejected,
  };
  const withNamed = (values: readonly string[], value?: string | null) => (value && !values.includes(value) ? [...values, value] : values);
  const options = (values: readonly string[]) =>
    values.filter((value) => value && !value.includes(",")).map((value) => ({ value, label: value }));
  return defineListQuery({
    key: "gateway-ops.capabilities",
    fields: {
      window: field.timeRange({
        label: t.window,
        common: true,
        custom: false,
        presets: CAPABILITY_WINDOWS.map((value) => ({ value, label: windowLabel[value] })),
        required: { kind: "preset", preset: "24h" },
      }),
      app: field.choice({ label: t.app, common: true, multiple: false, options: options(withNamed(scope.apps, named.app)) }),
      capability: field.choice({
        label: t.capability,
        multiple: false,
        options: options(withNamed(scope.capabilities, named.capability)),
      }),
      origin: field.choice({
        label: t.origin,
        multiple: false,
        options: CAPABILITY_ORIGINS.map((value) => ({ value, label: originLabel[value] })),
      }),
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: CAPABILITY_STATUSES.map((value) => ({ value, label: statusLabel[value] })),
      }),
      destructive: field.choice({ label: t.destructive, multiple: false, options: [{ value: "1", label: t.destructiveOnly }] }),
      // A user comes from a link (a person's page, AI usage); it is named, not searched.
      user: field.lookup({ label: t.user, multiple: false, limit: 1, load: async () => ({ items: [] }), resolve: asItems }),
    },
    sort: { fixed: { field: "startedAt", direction: "desc", label: t.startedAt } },
    pageParams: ["tab", "request", "cursor"],
  });
};

export type CapabilitiesQuery = ReturnType<typeof capabilitiesQuery>;
export type CapabilitiesState = ListQueryStateOf<CapabilitiesQuery>;

export type CapabilitiesAddress = {
  state: CapabilitiesState;
  tab: CapabilityTab;
  request: string | null;
  cursor: string | null;
  issues: readonly ListQueryIssue[];
};

/** Reads an address with the declaration; a user that is no UUID is no filter the store can read. Never throws. */
export const parseCapabilitiesAddress = (query: CapabilitiesQuery, params: URLSearchParams): CapabilitiesAddress => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.filters.user !== undefined && !UUID.test(state.filters.user)) {
    issues.push({ code: "invalid", param: "user", value: state.filters.user });
    state = query.clear(state, "user");
  }
  const text = (name: string) => params.get(name)?.trim().slice(0, 300) || null;
  return {
    state,
    tab: CAPABILITY_TABS.find((tab) => tab === params.get("tab")) ?? "executions",
    request: text("request"),
    cursor: text("cursor"),
    issues,
  };
};

/** The address of a state plus the console's own parameters. A new state starts on the first page. */
export const capabilitiesHref = (
  query: CapabilitiesQuery,
  state: CapabilitiesState,
  extra: { tab?: CapabilityTab; request?: string | null; cursor?: string | null } = {},
) => {
  const params = query.serialize(state);
  if (extra.tab && extra.tab !== "executions") params.set("tab", extra.tab);
  if (extra.request) params.set("request", extra.request);
  if (extra.cursor) params.set("cursor", extra.cursor);
  const text = params.toString().replace(/%(?:2C|3A|2F|40)/gi, decodeURIComponent);
  return text ? `${CAPABILITIES_PATH}?${text}` : CAPABILITIES_PATH;
};

export const windowStart = (state: CapabilitiesState, now = Date.now()) => {
  const window = state.filters.window;
  const preset = CAPABILITY_WINDOWS.find((value) => window.kind === "preset" && value === window.preset) ?? "24h";
  return new Date(now - WINDOW_MS[preset]);
};

/** The store filter of a state. */
export const executionFilter = (state: CapabilitiesState, now = Date.now()): CapabilityExecutionFilter => ({
  ...(state.filters.app ? { appId: state.filters.app } : {}),
  ...(state.filters.capability ? { capability: state.filters.capability } : {}),
  ...(state.filters.origin ? { origin: state.filters.origin } : {}),
  ...(state.filters.status ? { status: state.filters.status } : {}),
  ...(state.filters.user ? { userId: state.filters.user } : {}),
  ...(state.filters.destructive ? { destructive: true } : {}),
  since: windowStart(state, now),
});
