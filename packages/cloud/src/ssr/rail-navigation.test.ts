import { describe, expect, test } from "bun:test";
import { defaultRailPreferences, isRailShortcutHref, RailPreferencesSchema } from "../contracts/rail-preferences";
import { projectRailNavigation, type RailApp, railLinkActive, sortRailApps } from "./rail-navigation";

const app = (id: string, label: string, defaultVisible = true): RailApp => ({
  id,
  label,
  href: `/app/${id}`,
  match: `/app/${id}`,
  iconClass: "ti ti-apps",
  defaultVisible,
});
const apps = [app("z", "Zoo"), app("a", "Äpfel"), app("b", "Beta", false)];

describe("personal app rail", () => {
  test("sorts localized names and preserves default selection including newly installed apps", () => {
    expect(projectRailNavigation(apps, defaultRailPreferences(), "de").apps.map((x) => x.id)).toEqual(["a", "z"]);
    expect(sortRailApps([app("z", "Same"), app("a", "Same")], "en").map((x) => x.id)).toEqual(["a", "z"]);
    expect(sortRailApps(apps, "sv").map((x) => x.id)).toEqual(["b", "z", "a"]);
  });
  test("visibility overrides neither restore unavailable apps nor change the catalog", () => {
    const settings = { ...defaultRailPreferences(), visibility: { a: false, b: true, forbidden: true } };
    expect(projectRailNavigation(apps, settings, "de").apps.map((x) => x.id)).toEqual(["b", "z"]);
    expect(apps.length).toBe(3);
  });
  test("pins in personal order, suppresses duplicate apps, retains deep links and restores defaults on removal", () => {
    const settings = RailPreferencesSchema.parse({
      revision: 0,
      visibility: {},
      shortcuts: [
        { id: "first", kind: "app", appId: "z" },
        { id: "second", kind: "link", title: "Details", href: "/app/a/item?q=one", icon: "ti ti-link" },
        { id: "third", kind: "app", appId: "missing" },
      ],
    });
    const projected = projectRailNavigation(apps, settings, "de");
    expect(projected.shortcuts.map((x) => x.label)).toEqual(["Zoo", "Details"]);
    expect(projected.apps.map((x) => x.id)).toEqual(["a"]);
    expect(projectRailNavigation(apps, { ...settings, shortcuts: [] }, "de").apps.map((x) => x.id)).toEqual(["a", "z"]);
    expect(settings.shortcuts).toHaveLength(3);
  });
  test("app active states respect path boundaries and root; deep links include query/hash and origin", () => {
    const link = app("mail", "Mail");
    expect(railLinkActive(link, "https://cloud.test/app/mail/inbox")).toBe(true);
    expect(railLinkActive(link, "https://cloud.test/app/mailbox")).toBe(false);
    expect(railLinkActive({ ...link, match: "/" }, "https://cloud.test/app/mail")).toBe(false);
    const exact = { ...link, match: "/app/mail?q=one#item", exact: true };
    expect(railLinkActive(exact, "https://cloud.test/app/mail?q=one#item")).toBe(true);
    expect(railLinkActive(exact, "https://cloud.test/app/mail?q=two#item")).toBe(false);
    expect(railLinkActive({ ...exact, match: "https://outside.test/app/mail?q=one#item" }, "https://cloud.test/app/mail?q=one#item")).toBe(
      false,
    );
  });
  test("rejects unsafe link forms while allowing local paths and web links", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,x",
      "//outside.test",
      "/\\outside.test",
      "https://user:password@outside.test",
      "/\noutside.test",
      "relative",
    ])
      expect(isRailShortcutHref(href)).toBe(false);
    for (const href of ["/", "/app/grids/base?q=test#x", "https://example.com/a", "http://localhost:3000/"])
      expect(isRailShortcutHref(href)).toBe(true);
  });
  test("bounds payloads, rejects duplicate pins and user identity injection", () => {
    const shortcut = { id: "one", kind: "app", appId: "mail" };
    expect(RailPreferencesSchema.safeParse({ ...defaultRailPreferences(), userId: "other" }).success).toBe(false);
    expect(RailPreferencesSchema.safeParse({ ...defaultRailPreferences(), shortcuts: [shortcut, shortcut] }).success).toBe(false);
    expect(
      RailPreferencesSchema.safeParse({ ...defaultRailPreferences(), shortcuts: [shortcut, { ...shortcut, id: "two" }] }).success,
    ).toBe(false);
    expect(
      RailPreferencesSchema.safeParse({
        ...defaultRailPreferences(),
        visibility: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`app-${i}`, true])),
      }).success,
    ).toBe(false);
  });
});

test("app IDs matching Object prototype names still follow their declared defaults", () => {
  expect(projectRailNavigation([app("constructor", "Constructor", false)], defaultRailPreferences(), "en").apps).toEqual([]);
});
