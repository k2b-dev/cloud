import { buildGroupDetailUrl, GROUPS_CONTEXT_QUERY_KEYS, type GroupQueryKeys, type GroupsListState } from "../../lib/url-state";

const GROUP_DETAIL_TABS = ["members", "managers", "member-of", "relations"] as const;

export type GroupDetailTab = (typeof GROUP_DETAIL_TABS)[number];

/** Tabs only administrators see: the groups a group belongs to, and the relations of groups. */
const ADMIN_TABS = new Set<GroupDetailTab>(["member-of", "relations"]);

type DetailHrefOptions = {
  listState: GroupsListState;
  defaultScope: GroupsListState["scope"];
  keys?: GroupQueryKeys;
};

type DetailQueryOverrides = Record<string, string | null | undefined>;

export const getVisibleGroupDetailTabs = (isAdmin: boolean): GroupDetailTab[] =>
  GROUP_DETAIL_TABS.filter((tab) => isAdmin || !ADMIN_TABS.has(tab));

export const parseGroupDetailTab = (requested: string | undefined, isAdmin: boolean): GroupDetailTab => {
  const tab = GROUP_DETAIL_TABS.find((entry) => entry === requested) ?? "members";
  return ADMIN_TABS.has(tab) && !isAdmin ? "members" : tab;
};

export const createGroupDetailHrefBuilder =
  ({ listState, defaultScope, keys = GROUPS_CONTEXT_QUERY_KEYS }: DetailHrefOptions) =>
  (targetGroupId: string, overrides: DetailQueryOverrides = {}): string => {
    const base = buildGroupDetailUrl(targetGroupId, listState, {
      keys,
      defaultScope,
    });
    const url = new URL(base, "https://local.invalid");

    for (const [key, value] of Object.entries(overrides)) {
      if (value === null || value === undefined || value.length === 0) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, value);
      }
    }

    return `${url.pathname}${url.search}`;
  };

const buildPageBaseUrl = (href: string): string => `${href}${href.includes("?") ? "&" : "?"}page=`;

export const buildGroupDetailPageBaseUrl = (
  buildDetailHref: ReturnType<typeof createGroupDetailHrefBuilder>,
  groupId: string,
  overrides: DetailQueryOverrides,
): string => buildPageBaseUrl(buildDetailHref(groupId, { ...overrides, page: null }));
