import { describe, expect, test } from "bun:test";

// A personal group's tag, its owner link and why it cannot be deleted are checked where they render: the group record's
// render test (`src/frontend/groups/detail/page.render.test.tsx`) and browser test (`group-screen.browser.test.ts`).
const toggle = { en: "Personal groups", de: "Persönliche Gruppen" } as const;

describe("personal Linux groups in Accounts", () => {
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
