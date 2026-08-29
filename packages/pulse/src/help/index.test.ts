import { describe, expect, test } from "bun:test";
import { pulseHelp } from ".";

describe("pulse help", () => {
  test("keeps every English and German topic in its established order", () => {
    expect(pulseHelp.documents.map((document) => document.id)).toEqual([
      "pulse-start",
      "pulse-data-model",
      "pulse-find-data",
      "pulse-query-language",
      "pulse-dashboard-dsl",
      "pulse-reference",
      "pulse-operate",
    ]);

    const english = pulseHelp.documentsByLocale?.en ?? [];
    const german = pulseHelp.documentsByLocale?.de ?? [];
    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }
  });

  test("preserves the query and dashboard reference content", () => {
    const queryHelp = pulseHelp.getMarkdown("pulse-query-language");
    const dashboardHelp = pulseHelp.getMarkdown("pulse-dashboard-dsl");
    expect(queryHelp).toContain("metric http_requests_total rate every 1m since 1h");
    expect(queryHelp).toContain("more than 2,000 time windows");
    expect(queryHelp).toContain("Metric queries use two reduction stages");
    expect(queryHelp).toContain("group by resource");
    expect(queryHelp).toContain("Shared clauses may follow");
    expect(queryHelp).toContain("backslash escapes the next character");
    expect(queryHelp).toContain("Query text is limited to 2,000 characters");
    expect(dashboardHelp).toContain("Public displays use control defaults");
    expect(dashboardHelp).toContain("Cards cannot contain nested cards or sections");
    expect(dashboardHelp).toContain("dashboard, section, row, card");
    expect(dashboardHelp).toContain('An empty `dashboard "Name" {}` document is valid');
    expect(dashboardHelp).toContain("Dashboard statements and visual names are case-sensitive");
    expect(dashboardHelp).toContain("`visual <type>`");
    expect(dashboardHelp).toContain('map "Recent engagement"');
    expect(dashboardHelp).toContain("latitude attribute geo.latitude");
    expect(dashboardHelp).toContain("Sensitive fields cannot be selected");
    expect(dashboardHelp).toContain("at most 1,000 aggregated points");
    expect(dashboardHelp).toContain("Dashboard DSL is limited to 40,000 characters");
  });

  test("keeps implementation details out of end-user help", () => {
    const help = ["en", "de"]
      .flatMap((locale) => pulseHelp.documents.map((document) => pulseHelp.getMarkdown(document.id, locale)))
      .join("\n");
    expect(help).not.toMatch(
      /\bPostgres(?:QL)?\b|\bTimescaleDB\b|\bSQL\b|background jobs?|hourly metric rollups?|continuous aggregates?|time_bucket|\bKiB\b|\bMiB\b|storage engine|source of truth|\bcanonical\b|\bparser\b|\bcompiler\b|raw events?|high-cardinality/i,
    );
  });

  test("serves the complete German collection for regional locales", () => {
    expect(pulseHelp.getMarkdown("pulse-start", "de-CH")).toContain("Pulse verwandelt eingehende Daten");
    expect(pulseHelp.getMarkdown("pulse-data-model", "de-CH")).toContain("Der Weg von der Quelle zum Diagramm");
    expect(pulseHelp.getMarkdown("pulse-find-data", "de-CH")).toContain("In dieser Reihenfolge eingrenzen");
    expect(pulseHelp.getMarkdown("pulse-query-language", "de-CH")).toContain("Metrikabfragen verwenden zwei Reduktionsstufen");
    expect(pulseHelp.getMarkdown("pulse-dashboard-dsl", "de-CH")).toContain("Öffentliche Anzeigen verwenden Standardwerte");
    expect(pulseHelp.getMarkdown("pulse-reference", "de-CH")).toContain("IDs aus sechs Zeichen");
    expect(pulseHelp.getMarkdown("pulse-operate", "de-CH")).toContain("Anfragen werden vollständig oder gar nicht angenommen");
  });

  test("keeps executable DSL examples identical across locales", () => {
    const codeBlocks = (markdown: string | undefined) => markdown?.match(/```[\s\S]*?```/g) ?? [];

    for (const id of ["pulse-query-language", "pulse-dashboard-dsl"]) {
      const english = pulseHelp.getMarkdown(id, "en");
      const german = pulseHelp.getMarkdown(id, "de");
      expect(english).toBeDefined();
      expect(german).toBeDefined();
      expect(codeBlocks(german)).toEqual(codeBlocks(english));
    }
  });

  test("falls back to English for unsupported locales", () => {
    expect(pulseHelp.getMarkdown("pulse-start", "fr")).toBe(pulseHelp.getMarkdown("pulse-start"));
    expect(pulseHelp.getMarkdown("pulse-start", "fr")).toContain("Pulse turns incoming data");
  });
});
