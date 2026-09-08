import { describe, expect, it } from "bun:test";
import type { RuntimeAppMeta } from "../contracts/app";
import { activeAdminHref } from "./admin-active-link";
import { buildAdminGroups } from "./admin-navigation";

const app = (overrides: Partial<RuntimeAppMeta> = {}): RuntimeAppMeta => ({
  id: "example",
  name: "Example",
  icon: "ti ti-box",
  description: "Example app",
  routes: ["/app/example"],
  ...overrides,
});

describe("buildAdminGroups", () => {
  it("links to AI usage in both supported locales", () => {
    for (const [locale, label] of [
      ["en", "Usage"],
      ["de", "Nutzung"],
    ] as const) {
      expect(buildAdminGroups([], locale).flatMap((group) => group.links)).toContainEqual({
        href: "/admin/settings?tab=ai-usage",
        icon: "ti-chart-histogram",
        label,
      });
    }
  });
  it("renders app-declared groups in the existing core group order", () => {
    const groups = buildAdminGroups([
      app({
        adminHref: "/admin/example",
        adminNav: [
          {
            label: "Operations",
            links: [{ href: "/admin/example/jobs", icon: "ti-activity", label: "Jobs" }],
          },
        ],
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["General", "Operations", "Accounts & sign-in", "AI", "Settings"]);
    expect(groups[1]?.links).toEqual([{ href: "/admin/example/jobs", icon: "ti-activity", label: "Jobs" }]);
    expect(groups.find((group) => group.label === "AI")?.links).toContainEqual({
      href: "/admin/settings?tab=ai-projects",
      icon: "ti-folders",
      label: "Projects",
    });
  });

  it("keeps adminHref as the single-link fallback", () => {
    const groups = buildAdminGroups([app({ adminHref: "/admin/example" })]);

    expect(groups.at(-1)).toEqual({
      label: "App administration",
      links: [{ href: "/admin/example", icon: "ti-box", label: "Example" }],
    });
  });

  it("drops non-admin and external links", () => {
    const groups = buildAdminGroups([
      app({
        adminHref: "https://example.com/admin",
        adminNav: [
          {
            label: "Invalid",
            links: [
              { href: "/app/example", icon: "ti-box", label: "App" },
              { href: "//example.com/admin", icon: "ti-link", label: "External" },
            ],
          },
        ],
      }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["General", "Accounts & sign-in", "AI", "Settings"]);
  });
  it("groups global account controls once and preserves existing links", () => {
    const groups = buildAdminGroups([]);
    const accounts = groups.find((group) => group.label === "Accounts & sign-in")!;
    expect(accounts.links.map((link) => link.href)).toEqual(
      ["user", "registration", "linux", "account-operations", "freeipa"].map((tab) => `/admin/settings?tab=${tab}`),
    );
    const all = groups.flatMap((group) => group.links.map((link) => link.href));
    expect(new Set(all).size).toBe(all.length);
    expect(
      buildAdminGroups([], "de")
        .find((group) => group.label === "Accounts & Anmeldung")
        ?.links.map((link) => link.label),
    ).toEqual(["Anmeldung", "Registrierung & Anfragen", "Linux-Identitäten", "Betrieb", "FreeIPA"]);
  });
});

describe("activeAdminHref", () => {
  const observability = [
    "/admin",
    "/admin/observability",
    "/admin/observability/logs",
    "/admin/observability/telemetry",
    "/admin/observability/jobs",
  ];

  it("lights the most specific link, not every ancestor", () => {
    // The observability overview sits at the prefix of every sibling, so plain
    // prefix matching left it highlighted next to the page actually open.
    expect(activeAdminHref("/admin/observability/telemetry", observability)).toBe("/admin/observability/telemetry");
  });

  it("keeps the overview active on its own page", () => {
    expect(activeAdminHref("/admin/observability", observability)).toBe("/admin/observability");
  });

  it("keeps a section link active on its sub-pages", () => {
    expect(activeAdminHref("/admin/observability/telemetry/detail", observability)).toBe("/admin/observability/telemetry");
  });

  it("does not let the admin root swallow every page", () => {
    expect(activeAdminHref("/admin/observability/jobs", observability)).toBe("/admin/observability/jobs");
    expect(activeAdminHref("/admin", observability)).toBe("/admin");
  });

  it("ignores a query string on ordinary links", () => {
    expect(activeAdminHref("/admin/observability/jobs?health=stuck", observability)).toBe("/admin/observability/jobs");
  });

  it("distinguishes settings tabs by query parameter", () => {
    const settings = ["/admin/settings?tab=general", "/admin/settings?tab=mail"];
    expect(activeAdminHref("/admin/settings?tab=mail", settings)).toBe("/admin/settings?tab=mail");
  });

  it("returns nothing when no link covers the path", () => {
    expect(activeAdminHref("/admin/accounts", ["/admin/observability"])).toBeNull();
  });

  it("does not treat a shared name prefix as a match", () => {
    // "/admin/observability-legacy" must not match "/admin/observability".
    expect(activeAdminHref("/admin/observability-legacy", ["/admin/observability"])).toBeNull();
  });
});
