import { describe, expect, test } from "bun:test";
import type { GroupsListState } from "../../lib/url-state";
import {
  buildGroupDetailPageBaseUrl,
  createGroupDetailHrefBuilder,
  getVisibleGroupDetailTabs,
  parseGroupDetailTab,
} from "./group-detail-url";

const listState: GroupsListState = {
  search: "ops",
  page: 2,
  provider: "ipa",
  scope: "managed",
};

describe("group detail URL helpers", () => {
  test("keeps list context separate from tab-local query params", () => {
    const buildHref = createGroupDetailHrefBuilder({ listState, defaultScope: "member" });

    expect(buildHref("group-1", { tab: "members", search: null, page: null })).toBe(
      "/app/accounts/groups/group-1?list_search=ops&list_page=2&list_provider=ipa&list_scope=managed&tab=members",
    );
  });

  test("builds page base URLs without duplicating href generation", () => {
    const buildHref = createGroupDetailHrefBuilder({ listState, defaultScope: "member" });

    expect(
      buildGroupDetailPageBaseUrl(buildHref, "group-1", {
        tab: "members",
        search: "eva",
        indirect: "true",
        service_accounts: "true",
      }),
    ).toBe(
      "/app/accounts/groups/group-1?list_search=ops&list_page=2&list_provider=ipa&list_scope=managed&tab=members&search=eva&indirect=true&service_accounts=true&page=",
    );
  });

  test("guards the administrators' tabs for everyone else", () => {
    expect(parseGroupDetailTab("member-of", false)).toBe("members");
    expect(parseGroupDetailTab("member-of", true)).toBe("member-of");
    expect(parseGroupDetailTab("unknown", true)).toBe("members");
    expect(parseGroupDetailTab("relations", false)).toBe("members");
    expect(parseGroupDetailTab("relations", true)).toBe("relations");
  });

  test("hides the administrators' tabs from everyone else", () => {
    expect(getVisibleGroupDetailTabs(false)).toEqual(["members", "managers"]);
    expect(getVisibleGroupDetailTabs(true)).toEqual(["members", "managers", "member-of", "relations"]);
  });
});
