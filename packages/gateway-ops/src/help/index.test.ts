import { describe, expect, test } from "bun:test";
import { gatewayOpsHelp } from ".";

describe("gatewayOpsHelp", () => {
  test("owns the existing Gateway Ops help topics as English Markdown", () => {
    expect(gatewayOpsHelp.documents.map((document) => document.id)).toEqual([
      "gateway-ops-start",
      "gateway-ops-incident",
      "gateway-ops-operations",
      "gateway-ops-reference",
    ]);

    expect(gatewayOpsHelp.getMarkdown("gateway-ops-start")).toContain("Gateway Ops is the admin console");
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-incident")).toContain("Use one signal to narrow the incident");
  });

  test("translates every article to German with matching icon and order", () => {
    const english = gatewayOpsHelp.documentsByLocale?.en ?? [];
    const german = gatewayOpsHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(gatewayOpsHelp.getMarkdown("gateway-ops-start", "de")).toContain("Gateway Ops ist die Administrationsoberfläche");
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-incident", "de")).toContain("Grenze die Störung anhand eines Signals ein");
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-operations", "de")).toContain("Die Administrationsseiten werden serverseitig gerendert");
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-reference", "de")).toContain("Gateway Ops fasst Signale der Plattform zusammen");
  });

  test("resolves regional and unknown locales through the fallback chain", () => {
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-start", "de-CH")).toBe(gatewayOpsHelp.getMarkdown("gateway-ops-start", "de")!);
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-start", "de-CH")).toContain("Gateway Ops ist die Administrationsoberfläche");
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-start", "fr")).toBe(gatewayOpsHelp.getMarkdown("gateway-ops-start")!);
    expect(gatewayOpsHelp.getMarkdown("gateway-ops-start", "fr")).toContain("Gateway Ops is the admin console");
  });
});
