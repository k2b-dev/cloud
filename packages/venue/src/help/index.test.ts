import { describe, expect, test } from "bun:test";
import { venueHelp } from ".";

describe("venueHelp", () => {
  test("serves the Venue help topics in English and German", async () => {
    expect(venueHelp.documents.map((document) => document.id)).toEqual(["venue-start", "venue-work", "venue-troubleshooting"]);
    expect(venueHelp.getMarkdown("venue-start")).toContain("Venues manages staffed places");
    expect(venueHelp.getMarkdown("venue-start", "de-CH")).toContain("Standorte verwaltet Orte");
    expect(venueHelp.getMarkdown("venue-work")).toContain("The venue workspace separates daily staffing");
    expect(venueHelp.getMarkdown("venue-work", "de")).toContain("Der Standort-Arbeitsbereich trennt");
    expect(venueHelp.getMarkdown("venue-troubleshooting")).toContain("The public page shows the wrong opening status");
    expect(venueHelp.getMarkdown("venue-troubleshooting", "de-DE")).toContain("Die öffentliche Seite zeigt den falschen Öffnungsstatus");
  });
});
