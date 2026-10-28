import { describe, expect, it } from "bun:test";
import type { RuntimeAppMeta } from "../contracts/app";
import { activeAdminHref, activeAdminLink } from "./admin-active-link";
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
  it("makes the places and maps page reachable and active in both locales", () => {
    const href = "/admin/places-and-maps";
    for (const [locale, label] of [
      ["en", "Places and maps"],
      ["de", "Orte und Karten"],
    ] as const) {
      const links = buildAdminGroups([], locale).flatMap((group) => group.links);
      expect(links).toContainEqual({ href, icon: "ti-map-2", label });
      expect(
        activeAdminHref(
          href,
          links.map((link) => link.href),
        ),
      ).toBe(href);
    }
  });

  it("links to the one AI area in both supported locales", () => {
    for (const [locale, label] of [
      ["en", "AI"],
      ["de", "KI"],
    ] as const) {
      expect(buildAdminGroups([], locale).find((group) => group.label === "Cloud")?.links).toEqual([
        { href: "/admin/ai", icon: "ti-sparkles", label },
      ]);
    }
  });
  it("leaves declared AI tools to the AI area instead of the sidebar", () => {
    const groups = buildAdminGroups([
      app({
        adminHref: "/admin/example",
        adminNav: [
          {
            section: "ai",
            label: "Example tools",
            links: [{ href: "/admin/example", icon: "ti ti-tool", label: "Script tools" }],
          },
        ],
      }),
    ]);
    expect(groups.find((group) => group.label === "Cloud")?.links).toEqual([{ href: "/admin/ai", icon: "ti-sparkles", label: "AI" }]);
    expect(groups.some((group) => group.label === "Example tools")).toBe(false);
    expect(groups.flatMap((group) => group.links).filter((link) => link.href === "/admin/example")).toHaveLength(0);
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

    expect(groups.map((group) => group.label)).toEqual(["General", "Cloud", "Operations", "Accounts & sign-in", "Settings"]);
    expect(groups[2]?.links).toEqual([{ href: "/admin/example/jobs", icon: "ti-activity", label: "Jobs" }]);
    expect(groups.find((group) => group.label === "Cloud")?.links).toEqual([{ href: "/admin/ai", icon: "ti-sparkles", label: "AI" }]);
  });

  it("shows contributed Observability pages as one area entry that stays active on all of them", () => {
    const groups = buildAdminGroups([
      app({
        id: "gateway-ops",
        adminHref: "/admin/observability",
        adminNav: [
          { section: "observability", label: "Gateway", links: [{ href: "/admin/observability/gateway", icon: "ti-apps", label: "Apps" }] },
          {
            section: "observability",
            label: "Observability",
            links: [
              { href: "/admin/observability", icon: "ti-stethoscope", label: "Overview" },
              { href: "/admin/observability/logs", icon: "ti-list-details", label: "Logs" },
            ],
          },
        ],
      }),
    ]);
    const area = groups.find((group) => group.label === "Cloud")!;
    expect(area.links.map((link) => link.href)).toEqual(["/admin/ai", "/admin/observability"]);
    expect(groups.some((group) => group.label === "Gateway" || group.label === "Observability")).toBe(false);
    expect(groups.some((group) => group.label === "App administration")).toBe(false);
    const links = groups.flatMap((group) => group.links);
    for (const path of ["/admin/observability", "/admin/observability/logs?level=error", "/admin/observability/gateway"]) {
      expect(activeAdminLink(path, links)?.href).toBe("/admin/observability");
    }
    expect(activeAdminLink("/admin/ai", links)?.href).toBe("/admin/ai");
    expect(
      buildAdminGroups([], "de")
        .find((group) => group.label === "Cloud")
        ?.links.map((link) => link.label),
    ).toEqual(["KI"]);
  });

  it("opens the first contributed Observability page when no app owns the area start", () => {
    const groups = buildAdminGroups([
      app({
        id: "inventory",
        adminNav: [
          { section: "observability", label: "Stock", links: [{ href: "/admin/inventory/health", icon: "ti-box", label: "Stock health" }] },
        ],
      }),
    ]);
    expect(groups.find((group) => group.label === "Cloud")?.links.at(-1)?.href).toBe("/admin/inventory/health");
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

    expect(groups.map((group) => group.label)).toEqual(["General", "Cloud", "Accounts & sign-in", "Settings"]);
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
