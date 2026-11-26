/**
 * The audit log's one declaration, the kind "Protokoll" of the activity page: its filters, its search and its address.
 * The SSR page reads and the browser writes the address only through it, so reload, back and a shared link show the
 * same events.
 *
 * Accounts filters on the server (`audit.list`); the declaration only names fields, values and bounds. The parameters
 * keep their names from the former audit page (`days`, `outcome`, `action`, `actor`, …); only the search moved from
 * `search` to `q` (`legacyAuditHref`). Automatic app entries and the page are page parameters beside the query.
 */
import type { AuditActionGroup, AuditListFilter, AuditOutcome } from "@k2b/cloud/services";
import {
  defineListQuery,
  field,
  type ListQueryIssue,
  type ListQueryStateOf,
  type LookupItem,
  type LookupLoadResult,
  type PeriodValue,
} from "@k2b/ui/v2/list-query";
import { ACTIVITY_PATH, kindField, legacyListHref } from "../activity/kind";
import { accountsMessages } from "../messages";
import { actionLabel, actionOptions } from "./audit-labels";
import { auditMessages } from "./messages";

export const AUDIT_PAGE_PATH = ACTIVITY_PATH;
/** Events per page, as before v2. */
export const AUDIT_PER_PAGE = 100;
/** Longest search and identity filter, as the audit API allows it. A longer text is dropped and reported. */
export const AUDIT_TEXT_MAX = 200;
/** Last page the list opens. */
export const AUDIT_PAGE_MAX = 10_000;

/** The days a time range reaches back, as the pre-v2 filter offered them; 30 when the address names none. */
export type AuditDays = "7" | "30" | "90";
const DEFAULT_DAYS: PeriodValue<AuditDays> = { kind: "preset", preset: "30" };

/** How the browser searches identities for the actor, target and service account filters. */
export type AuditLookup = {
  load: (query: string, context: { signal: AbortSignal; limit: number }) => Promise<LookupLoadResult>;
  resolve: (values: readonly string[], context: { signal: AbortSignal }) => Promise<readonly LookupItem[]>;
};
export type AuditLookups = { actor: AuditLookup; target: AuditLookup; serviceAccount: AuditLookup };

const none: AuditLookup = { load: async () => ({ items: [] }), resolve: async () => [] };

/** Builds the declaration in the request's language. `lookups` searches identities in the browser. */
export const auditQuery = (locale: string, lookups?: AuditLookups) => {
  const { t } = accountsMessages.resolve([locale]);
  const words = auditMessages.resolve([locale]).t;
  const sections = actionOptions(t);
  const actions: LookupItem[] = sections.flatMap((section) =>
    section.options.map((option) => ({ value: option.value, label: option.label, meta: section.label })),
  );
  const identity = (lookup: AuditLookup) => ({
    multiple: false as const,
    common: true,
    minChars: 2,
    load: lookup.load,
    resolve: lookup.resolve,
  });
  return defineListQuery({
    key: "accounts.audit",
    fields: {
      kind: kindField(locale),
      days: field.timeRange({
        label: t.timeRange,
        common: true,
        custom: false,
        presets: [
          { value: "7", label: words.last7d },
          { value: "30", label: words.last30d },
          { value: "90", label: words.last90d },
        ] satisfies { value: AuditDays; label: string }[],
        required: DEFAULT_DAYS,
      }),
      outcome: field.choice({
        label: t.outcome,
        common: true,
        multiple: false,
        options: [
          { value: "allowed", label: t.allowed },
          { value: "denied", label: t.denied },
          { value: "failed", label: t.failed },
        ] satisfies { value: AuditOutcome; label: string }[],
      }),
      action: field.lookup({
        label: t.action,
        common: true,
        multiple: false,
        limit: 50,
        // the actions are known: the lookup searches them in place, and names an unknown code by itself
        load: async (text, context) => {
          const needle = text.trim().toLowerCase();
          return {
            items: actions
              .filter((item) => !needle || item.label.toLowerCase().includes(needle) || item.value.includes(needle))
              .slice(0, context.limit),
          };
        },
        resolve: async (values) => values.map((value) => ({ value, label: actionLabel(value, t) })),
      }),
      actor: field.lookup({ label: t.actor, ...identity(lookups?.actor ?? none) }),
      target: field.lookup({ label: t.target, ...identity(lookups?.target ?? none) }),
      serviceAccountId: field.lookup({ label: t.serviceAccount, ...identity(lookups?.serviceAccount ?? none), common: false }),
      actionGroup: field.choice({
        label: t.area,
        multiple: false,
        options: [{ value: "service_accounts", label: t.serviceAccounts }] satisfies { value: AuditActionGroup; label: string }[],
      }),
      provider: field.choice({
        label: t.provider,
        multiple: false,
        options: [
          { value: "local", label: t.local },
          { value: "ipa", label: "FreeIPA" },
        ],
      }),
      // entries of rotating app keys; hidden unless the address shows them
      automatic: field.bool({ label: words.automatic, labels: { yes: words.shown, no: words.hidden } }),
    },
    search: { label: t.searchAudit },
    sort: { fixed: { field: "time", direction: "desc", label: words.newestFirst } },
    pageParams: ["page"],
  });
};

export type AuditQuery = ReturnType<typeof auditQuery>;
export type AuditState = ListQueryStateOf<AuditQuery>;

/** What the page reads from an address: the list state, the page, whether automatic entries show, and what was dropped. */
export type AuditAddress = { state: AuditState; page: number; automatic: boolean; issues: readonly ListQueryIssue[] };

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseAuditAddress = (query: AuditQuery, input: URLSearchParams): AuditAddress => {
  // the former `automatic=1` (before the field) means shown
  const params = new URLSearchParams(input);
  if (params.get("automatic") === "1") params.set("automatic", "yes");
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  if (state.search && state.search.length > AUDIT_TEXT_MAX) {
    issues.push({ code: "invalid", param: "q", value: state.search });
    state = { ...state, search: undefined };
  }
  for (const key of ["actor", "target", "action", "serviceAccountId"] as const) {
    const value = state.filters[key];
    if (value !== undefined && value.length > AUDIT_TEXT_MAX) {
      issues.push({ code: "invalid", param: key, value });
      state = query.clear(state, key);
    }
  }
  if (state.view !== undefined) {
    issues.push({ code: "invalid", param: "view", value: state.view });
    state = { ...state, view: undefined };
  }
  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const valid = Number.isSafeInteger(page) && page >= 1 && page <= AUDIT_PAGE_MAX;
  if (!valid) issues.push({ code: "invalid", param: "page", value: pageRaw ?? "" });
  return { state, page: valid ? page : 1, automatic: state.filters.automatic === true, issues };
};

/** The days a state reaches back. */
export const auditDays = (state: AuditState): number => {
  const days = state.filters.days;
  return days.kind === "preset" ? Number(days.preset) : 30;
};

/** The service filter a state asks for; automatic app entries stay hidden unless the address shows them. */
export const auditFilterOf = (state: AuditState, automatic: boolean): AuditListFilter => ({
  automatic: automatic ? "include" : "hide",
  search: state.search,
  actor: state.filters.actor,
  target: state.filters.target,
  action: state.filters.action,
  actionGroup: state.filters.actionGroup,
  serviceAccountId: state.filters.serviceAccountId,
  outcome: state.filters.outcome,
  provider: state.filters.provider,
  days: auditDays(state),
});

/** The address of a state, with its page. */
export const auditHref = (query: AuditQuery, state: AuditState, extra: { page?: number } = {}): string => {
  const params = query.serialize(state);
  if (extra.page && extra.page > 1) params.set("page", String(extra.page));
  const text = params.toString();
  return text ? `${AUDIT_PAGE_PATH}?${text}` : AUDIT_PAGE_PATH;
};

/** The activity address for an address of the former audit page (`/app/accounts/audit`), every filter carried over. */
export const legacyAuditHref = (params: URLSearchParams): string => {
  const next = new URLSearchParams(params);
  if (next.get("automatic") === "1") next.set("automatic", "yes");
  return legacyListHref("audit", next);
};
