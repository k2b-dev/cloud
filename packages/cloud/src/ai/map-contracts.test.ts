import { describe, expect, test } from "bun:test";
import { mapFixture } from "./map.test-fixture";
import { AI_MAP_MAX_DETAILS, AiMapSchema, AiMapToolInputSchema, aiMapDetailLink } from "./map-contracts";

describe("Assistant map details contract", () => {
  const detail = {
    id: "museum-0",
    note: "n".repeat(600),
    source: { label: "s".repeat(120), icon: "notebook" as const },
    links: Array.from({ length: 3 }, () => ({ label: "l".repeat(80), url: `/${"p".repeat(1999)}` })),
  };
  test("old maps remain valid and details accept the complete bounded shape", () => {
    expect(AiMapSchema.parse(mapFixture()).details).toBeUndefined();
    expect(AI_MAP_MAX_DETAILS).toBe(71);
    const details = Array.from({ length: AI_MAP_MAX_DETAILS }, (_, i) => ({ ...detail, id: String(i) }));
    expect(AiMapSchema.parse({ ...mapFixture(), details }).details).toEqual(details);
    for (const command of [
      { type: "describe", details },
      { type: "describe", web: [], details },
      { type: "describe", web: [] },
      {
        type: "route",
        title: "Tour",
        stops: [
          { id: "a", address: "Ulm" },
          { id: "b", address: "Blaubeuren" },
        ],
        details: [{ id: "a", note: "Start here" }],
      },
    ])
      expect(AiMapToolInputSchema.safeParse({ command }).success).toBe(true);
    expect(AiMapToolInputSchema.safeParse({ command: { type: "describe" } }).success).toBe(false);
    // A route's details name its own stops, so a typo fails before anything is calculated or announced.
    expect(
      AiMapToolInputSchema.safeParse({
        command: {
          type: "route",
          title: "Tour",
          stops: [
            { id: "a", address: "Ulm" },
            { id: "b", address: "Blaubeuren" },
          ],
          details: [{ id: "c", note: "Nowhere" }],
        },
      }).success,
    ).toBe(false);
  });
  test("rejects excess lengths, arbitrary icons and app-specific fields", () => {
    for (const invalid of [
      { ...detail, id: "" },
      { ...detail, id: "i".repeat(2049) },
      { ...detail, note: "n".repeat(601) },
      { ...detail, source: { label: "s".repeat(121) } },
      { ...detail, source: { label: "Source", icon: "ti ti-user injected" } },
      { ...detail, links: [...detail.links, detail.links[0]] },
      { ...detail, links: [{ label: "l".repeat(81), url: "/path" }] },
      { ...detail, links: [{ label: "Open", url: `/${"p".repeat(2000)}` }] },
      { ...detail, links: [{ label: "Open", url: "javascript:alert(1)" }] },
      { ...detail, links: [{ label: "Open", url: "/..//example.com" }] },
      { ...detail, appId: "some-app" },
    ])
      expect(AiMapToolInputSchema.safeParse({ command: { type: "describe", details: [invalid] } }).success).toBe(false);
    const excess = Array.from({ length: AI_MAP_MAX_DETAILS + 1 }, (_, i) => ({ id: String(i) }));
    expect(AiMapSchema.safeParse({ ...mapFixture(), details: excess }).success).toBe(false);
    expect(AiMapToolInputSchema.safeParse({ command: { type: "describe", details: excess } }).success).toBe(false);
  });
  test.each(["user", "file-text", "box", "notebook", "building", "calendar", "link", "info"])("accepts generic symbol %s", (icon) => {
    expect(AiMapSchema.safeParse({ ...mapFixture(), details: [{ id: "museum-0", source: { label: "Source", icon } }] }).success).toBe(true);
  });
  test.each([
    "/",
    "/app/example/Some place",
    "/app/example?id=1#details",
    "/app/example?next=https://example.com/",
    "https://example.com/",
    "http://example.com/",
  ])("renders safe link %s", (url) => {
    expect(aiMapDetailLink(url)).toBe(url);
  });
  test.each([
    "//example.com",
    "/..//example.com",
    "/.//example.com",
    "/%2e%2e//example.com",
    "/%2E.//example.com",
    "/a/../..//example.com",
    "/\\example.com",
    "/\n/example.com",
    "/\t/example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "mailto:a@example.com",
    "relative/path",
    " https://example.com",
    "https://[",
    "https:example.com",
  ])("does not render unsafe link %s", (url) => {
    expect(aiMapDetailLink(url)).toBeUndefined();
  });
});
