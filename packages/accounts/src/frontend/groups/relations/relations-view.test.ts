import { describe, expect, test } from "bun:test";
import { legacyRelationsHref, parseRelationsUrl, relationsHref } from "./relations-view";

const tech = "00000000-0000-4000-8000-000000000002";
const all = "00000000-0000-4000-8000-000000000001";
const params = (query: string) => new URLSearchParams(query);

describe("the relations view's address", () => {
  test("lives in the focus group's record and keeps defaults out", () => {
    const state = { ...parseRelationsUrl(() => undefined), focus: tech };
    expect(relationsHref(state)).toBe(`/app/accounts/groups/${tech}?tab=relations`);
    expect(relationsHref(state, { depth: 3, managers: true, sel: all }, "list_search=ops&list_page=2")).toBe(
      `/app/accounts/groups/${tech}?list_search=ops&list_page=2&tab=relations&sel=${all}&depth=3&managers=1`,
    );
    // the focus itself is never a selection, and expanded columns belong to the levels only
    expect(relationsHref(state, { sel: tech, view: "list", expand: ["d1"] })).toBe(`/app/accounts/groups/${tech}?tab=relations&view=list`);
  });

  test("an address of the former relations page leads to its focus group's record with every parameter", () => {
    expect(legacyRelationsHref(params(`focus=${tech}&sel=${all}&depth=3&view=graph&managers=1&expand=d1,u2,x9`), undefined)).toBe(
      `/app/accounts/groups/${tech}?tab=relations&sel=${all}&depth=3&managers=1&expand=d1%2Cu2`,
    );
    expect(legacyRelationsHref(params(`focus=${tech.toUpperCase()}&view=list`), undefined)).toBe(
      `/app/accounts/groups/${tech}?tab=relations&view=list`,
    );
  });

  test("without a valid focus it takes the server's default group, and without one there is nowhere to go", () => {
    expect(legacyRelationsHref(params("depth=4"), all)).toBe(`/app/accounts/groups/${all}?tab=relations&depth=4`);
    expect(legacyRelationsHref(params("focus=not-a-group&depth=4"), all)).toBe(`/app/accounts/groups/${all}?tab=relations&depth=4`);
    expect(legacyRelationsHref(params("depth=4"), null)).toBeNull();
    expect(legacyRelationsHref(params("focus=not-a-group"), undefined)).toBeNull();
  });
});
