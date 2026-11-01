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
  it("makes storage settings reachable and preserves their URL selection", () => {
    for (const [locale, label] of [
      ["en", "Storage"],
      ["de", "Speicher"],
    ] as const) {
      const links = buildAdminGroups([], locale).flatMap((group) => group.links);
      const href = "/admin/settings?tab=storage";
      expect(links).toContainEqual({ href, icon: "ti-database", label });
      expect(
        activeAdminHref(
          href,
          links.map((link) => link.href),
        ),
      ).toBe(href);
    }
  });
  it("makes the Base settings area reachable and active on its sections in both locales", () => {
    for (const [locale, label] of [
      ["en", "Base settings"],
      ["de", "Grundeinstellungen"],
    ] as const) {
      const links = buildAdminGroups([], locale).flatMap((group) => group.links);
      expect(links).toContainEqual({ href: "/admin/base", icon: "ti-adjustments", label });
      for (const path of ["/admin/base", "/admin/base/places", "/admin/base/legal"])
        expect(activeAdminLink(path, links)?.href).toBe("/admin/base");
      expect(links.some((link) => link.href.includes("places-and-maps") || link.href.includes("tab=general"))).toBe(false);
    }
  });

  it("links to the one AI area in both supported locales", () => {
    for (const [locale, label] of [
      ["en", "AI"],
      ["de", "KI"],
    ] as const) {
      expect(buildAdminGroups([], locale).find((group) => group.label === "Cloud")?.links).toEqual([
        { href: "/admin/base", icon: "ti-adjustments", label: locale === "de" ? "Grundeinstellungen" : "Base settings" },
        { href: "/admin/signin", icon: "ti-shield-lock", label: locale === "de" ? "Anmeldung & Sicherheit" : "Sign-in & security" },
        { href: "/admin/ai", icon: "ti-sparkles", label },
        { href: "/admin/code", icon: "ti-code", label: "Code" },
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
    expect(groups.find((group) => group.label === "Cloud")?.links).toEqual([
      { href: "/admin/base", icon: "ti-adjustments", label: "Base settings" },
      { href: "/admin/signin", icon: "ti-shield-lock", label: "Sign-in & security" },
      { href: "/admin/ai", icon: "ti-sparkles", label: "AI" },
      { href: "/admin/code", icon: "ti-code", label: "Code" },
    ]);
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

    expect(groups.map((group) => group.label)).toEqual(["General", "Cloud", "Operations", "Settings"]);
    expect(groups[2]?.links).toEqual([{ href: "/admin/example/jobs", icon: "ti-activity", label: "Jobs" }]);
    expect(groups.find((group) => group.label === "Cloud")?.links).toEqual([
      { href: "/admin/base", icon: "ti-adjustments", label: "Base settings" },
      { href: "/admin/signin", icon: "ti-shield-lock", label: "Sign-in & security" },
      { href: "/admin/ai", icon: "ti-sparkles", label: "AI" },
      { href: "/admin/code", icon: "ti-code", label: "Code" },
    ]);
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
    expect(area.links.map((link) => link.href)).toEqual([
      "/admin/base",
      "/admin/signin",
      "/admin/ai",
      "/admin/code",
      "/admin/observability",
    ]);
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
    ).toEqual(["Grundeinstellungen", "Anmeldung & Sicherheit", "KI", "Code"]);
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

    expect(groups.map((group) => group.label)).toEqual(["General", "Cloud", "Settings"]);
  });
  it("shows Sign-in & security as one area entry that stays active on its sections", () => {
    const links = buildAdminGroups([]).flatMap((group) => group.links);
    for (const path of ["/admin/signin", "/admin/signin/freeipa", "/admin/signin/linux?scope=all"]) {
      expect(activeAdminLink(path, links)?.href).toBe("/admin/signin");
    }
    expect(links.some((link) => /tab=(user|registration|linux|account-operations|freeipa|security)/.test(link.href))).toBe(false);
    const all = links.map((link) => link.href);
    expect(new Set(all).size).toBe(all.length);
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
