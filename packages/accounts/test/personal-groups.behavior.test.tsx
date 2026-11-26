import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

// A personal group's kind, its owner link and why it cannot be deleted are checked where they render: the group record's
// render test (`src/frontend/groups/detail/page.render.test.tsx`) and browser test (`group-screen.browser.test.ts`).
const toggle = { en: "Personal groups", de: "Persönliche Gruppen" } as const;

describe("personal Linux groups in Accounts", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  // the browser build of @k2b/ui, which the list declaration loads, needs a document while its modules evaluate
  let dom: ReturnType<typeof createDomTestHarness>;
  beforeEach(() => {
    dom = createDomTestHarness();
  });
  afterEach(() => dom.cleanup());

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: the group list's filters offer membership and origin without personal groups`, async () => {
      const { groupsHref, groupsQuery } = await import("../src/frontend/groups/query");
      const query = groupsQuery(locale, "member");
      const words = Object.values(query.fields).flatMap((field) =>
        "options" in field ? [field.label, ...field.options.map((option) => option.label)] : [field.label],
      );
      expect(words.some((word) => word.includes(toggle[locale]))).toBe(false);
      expect(Object.keys(query.fields)).toEqual(["scope", "provider"]);
      const all = query.set(query.reset(), "scope", "all");
      const ipa = all && query.set(all, "provider", "ipa");
      expect(ipa && groupsHref(query, ipa)).toBe("/app/accounts/groups?scope=all&provider=ipa");
    });
  }
});
