import { describe, expect, test } from "bun:test";
import { defaultRailPreferences, isRailShortcutHref, RailPreferencesSchema } from "../contracts/rail-preferences";
import { phoneBarItems, phoneBarLinks, projectRailNavigation, type RailApp, railLinkActive, sortRailApps } from "./rail-navigation";

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
  test("moving an app out of the default rail preserves explicit visibility and pins", () => {
    const catalog = [app("telemetry", "Telemetry", false)];
    const defaults = defaultRailPreferences();
    expect(projectRailNavigation(catalog, defaults, "en").apps).toEqual([]);
    expect(projectRailNavigation(catalog, { ...defaults, visibility: { telemetry: true } }, "en").apps.map((item) => item.id)).toEqual([
      "telemetry",
    ]);
    expect(projectRailNavigation(catalog, { ...defaults, visibility: { telemetry: false } }, "en").apps).toEqual([]);
    const pinned = { ...defaults, shortcuts: [{ id: "pin", kind: "app" as const, appId: "telemetry" }] };
    const navigation = projectRailNavigation(catalog, pinned, "en");
    expect(navigation.shortcuts.map((item) => item.appId)).toEqual(["telemetry"]);
    expect(navigation.apps).toEqual([]);
    expect(pinned.shortcuts).toEqual([{ id: "pin", kind: "app", appId: "telemetry" }]);
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
    expect(projected.shortcuts.map((x) => x.appId)).toEqual(["z", undefined]);
    expect(projected.apps.map((x) => x.appId)).toEqual(["a"]);
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
  test("SSR paths and the browser href agree on the active app across differing origins", () => {
    const link = app("mail", "Mail");
    // The server sees the internal upstream origin; the island later sees the public one.
    expect(railLinkActive(link, "/app/mail/inbox?view=mine")).toBe(true);
    expect(railLinkActive(link, "https://cloud.example.test/app/mail/inbox?view=mine")).toBe(true);
    expect(railLinkActive(link, "/app/mailbox")).toBe(false);
    const exact = { ...link, match: "/app/mail?q=one#item", exact: true };
    expect(railLinkActive(exact, "/app/mail?q=one#item")).toBe(true);
    expect(railLinkActive(exact, "/app/mail?q=two#item")).toBe(false);
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

test("managed shortcuts lead personal pins without deleting them, including after a personal reset", () => {
  const managedShortcuts = [{ id: "global-mail", kind: "app" as const, appId: "mail" }];
  const settings = {
    ...defaultRailPreferences(),
    visibility: { mail: false },
    managedShortcuts,
    shortcuts: [
      { id: "personal-mail", kind: "app" as const, appId: "mail" },
      { id: "deep", kind: "link" as const, title: "Inbox", href: "/app/mail/inbox", icon: "ti ti-link" },
    ],
  };
  const catalog = [{ id: "mail", label: "Mail", href: "/app/mail", match: "/app/mail", iconClass: "ti ti-mail", defaultVisible: true }];
  expect(projectRailNavigation(catalog, settings, "en").shortcuts.map((link) => link.id)).toEqual(["global-mail", "deep"]);
  expect(projectRailNavigation(catalog, { ...defaultRailPreferences(), managedShortcuts }, "en").shortcuts.map((link) => link.id)).toEqual([
    "global-mail",
  ]);
  expect(projectRailNavigation([], settings, "en").shortcuts.map((link) => link.id)).toEqual(["deep"]);
  expect(settings.shortcuts).toHaveLength(2);
  expect(projectRailNavigation(catalog, { ...settings, managedShortcuts: [] }, "en").shortcuts.map((link) => link.id)).toEqual([
    "personal-mail",
    "deep",
  ]);
});

test("Core Help marks only its owning app, including third-party apps", () => {
  for (const id of ["spaces", "timetrack"]) {
    const owner = { ...app(id, id), appId: id };
    for (const path of [`/help/apps/${id}`, `/help/apps/${id}/start/`]) {
      expect(railLinkActive(owner, path)).toBe(true);
      expect(railLinkActive({ ...app("core", "Core"), match: "/help", appId: "core" }, path)).toBe(false);
      expect(railLinkActive({ ...app("mail", "Mail"), appId: "mail" }, path)).toBe(false);
      expect(railLinkActive({ ...owner, appId: undefined, match: path, exact: true }, path)).toBe(true);
    }
  }
  const spaces = { ...app("spaces", "Spaces"), appId: "spaces" };
  for (const path of ["/help", "/help/apps", "/help/apps/spaces/a/b", "/helpx/apps/spaces", "/app/timetrack"])
    expect(railLinkActive(spaces, path)).toBe(false);
});

describe("phone bar links", () => {
  const apps = ["a", "b", "c", "d", "e", "f"].map((id) => app(id, id));
  const navigation = { shortcuts: [app("pinned", "Pinned")], apps };
  test("keeps shortcuts first, preserves rail order and applies the limit", () => {
    expect(phoneBarLinks(navigation, "/", 4)).toEqual([navigation.shortcuts[0]!, ...apps.slice(0, 3)]);
    expect(phoneBarLinks(navigation, "/", 2)).toEqual([navigation.shortcuts[0]!, apps[0]!]);
    expect(phoneBarLinks({ shortcuts: [], apps: apps.slice(0, 2) }, "/", 4)).toEqual(apps.slice(0, 2));
  });
  test("a current app after the limit replaces the last place without reordering the others", () => {
    expect(phoneBarLinks(navigation, "/app/f/inbox", 4)).toEqual([navigation.shortcuts[0]!, ...apps.slice(0, 2), apps[5]!]);
  });
  test("a current app inside the limit leaves the selection unchanged", () => {
    expect(phoneBarLinks(navigation, "/app/b", 4)).toEqual(phoneBarLinks(navigation, "/", 4));
    expect(phoneBarLinks(navigation, "/app/pinned", 4)).toEqual(phoneBarLinks(navigation, "/", 4));
  });
  test("Home leads to / and is the open item there and on the start page that / opens", () => {
    const home = { label: "Home", path: "/app/dashboard?view=today" };
    const current = (path: string) =>
      phoneBarItems(navigation, path, home)
        .filter((item) => item.current)
        .map((item) => item.id);
    expect(phoneBarItems(navigation, "/", home)[0]).toMatchObject({ id: "home", href: "/", label: "Home", icon: "ti ti-home" });
    expect(phoneBarItems(navigation, "/", home)).toHaveLength(5);
    expect(current("/")).toEqual(["home"]);
    expect(current("/app/dashboard")).toEqual(["home"]);
    expect(current("/app/dashboard/widgets")).toEqual(["home"]);
    expect(current("/app/dashboards")).toEqual([]);
    expect(current("/app/b/inbox")).toEqual(["b"]);
    // A start page that is an app in the bar marks the app, not Home.
    expect(
      phoneBarItems(navigation, "/app/b", { label: "Home", path: "/app/b" })
        .filter((item) => item.current)
        .map((item) => item.id),
    ).toEqual(["b"]);
  });
});
