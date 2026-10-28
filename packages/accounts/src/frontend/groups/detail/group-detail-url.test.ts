// fallow-ignore-file unused-file
import { describe, expect, test } from "bun:test";
import type { GroupsListState } from "../../lib/url-state";
import {
  buildGroupDetailPageBaseUrl,
  createGroupDetailHrefBuilder,
  getGroupsBackLabel,
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

  test("guards member-of tab for non-admin users", () => {
    expect(parseGroupDetailTab("member-of", false)).toBe("members");
    expect(parseGroupDetailTab("member-of", true)).toBe("member-of");
    expect(parseGroupDetailTab("unknown", true)).toBe("members");
  });

  test("hides member-of tab for non-admin users", () => {
    expect(getVisibleGroupDetailTabs(false)).toEqual(["members", "managers"]);
    expect(getVisibleGroupDetailTabs(true)).toEqual(["members", "managers", "member-of"]);
  });

  test("formats list back labels", () => {
    expect(getGroupsBackLabel("managed")).toBe("Managed Groups");
    expect(getGroupsBackLabel("member")).toBe("My Groups");
    expect(getGroupsBackLabel("all")).toBe("All Groups");
  });
});
