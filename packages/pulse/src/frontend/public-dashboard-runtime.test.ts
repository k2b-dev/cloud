import { describe, expect, test } from "bun:test";
import {
  parsePublicDashboardDisplayHeight,
  parsePublicDashboardTheme,
  publicDashboardEventSubject,
  publicDashboardRefreshBackoffMs,
  publicDashboardRefreshDelayMs,
  publicDashboardRefreshJitterMs,
  publicDashboardStateRowId,
  resolvePublicDashboardRefreshSeconds,
  sanitizePublicDashboardMarkdown,
} from "./public-dashboard-runtime";

describe("Pulse public dashboard runtime helpers", () => {
  test("parses public display options with conservative defaults", () => {
    expect(parsePublicDashboardTheme("dark")).toBe("dark");
    expect(parsePublicDashboardTheme("light")).toBe("light");
    expect(parsePublicDashboardTheme("system")).toBe("light");
    expect(parsePublicDashboardTheme(undefined)).toBe("light");

    expect(parsePublicDashboardDisplayHeight("full")).toBe("full");
    expect(parsePublicDashboardDisplayHeight("scroll")).toBe("scroll");
    expect(parsePublicDashboardDisplayHeight("anything")).toBe("scroll");
    expect(parsePublicDashboardDisplayHeight(null)).toBe("scroll");
  });

  test("resolves dashboard refresh settings", () => {
    expect(resolvePublicDashboardRefreshSeconds(undefined)).toBe(5);
    expect(resolvePublicDashboardRefreshSeconds(10)).toBe(10);
    expect(resolvePublicDashboardRefreshSeconds(null)).toBeNull();
  });

  test("bounds refresh backoff and jitter", () => {
    expect(publicDashboardRefreshBackoffMs(5, 0)).toBe(5_000);
    expect(publicDashboardRefreshBackoffMs(5, 1)).toBe(10_000);
    expect(publicDashboardRefreshBackoffMs(10, 10)).toBe(60_000);

    expect(publicDashboardRefreshJitterMs(-1)).toBe(0);
    expect(publicDashboardRefreshJitterMs(0.5)).toBe(175);
    expect(publicDashboardRefreshJitterMs(2)).toBe(349);

    expect(publicDashboardRefreshDelayMs(5, 1, 0.5)).toBe(10_175);
  });

  test("normalizes public event and state display identities", () => {
    expect(
      publicDashboardEventSubject({
        id: "event_1",
        kind: "deploy",
        ts: "2026-01-01T00:00:00.000Z",
        value: null,
        resourceKey: "service:api",
        resourceType: null,
      }),
    ).toBe("service:api");
    expect(
      publicDashboardEventSubject({
        id: "event_1",
        kind: "deploy",
        ts: "2026-01-01T00:00:00.000Z",
        value: null,
        resourceKey: null,
        resourceType: "service",
      }),
    ).toBe("service");
    expect(
      publicDashboardEventSubject({
        id: "event_1",
        kind: "deploy",
        ts: "2026-01-01T00:00:00.000Z",
        value: null,
        resourceKey: null,
        resourceType: null,
      }),
    ).toBe("-");

    expect(
      publicDashboardStateRowId({
        variantKey: "opaque-variant",
        key: "service.online",
        value: true,
        resourceKey: "service:api",
        resourceType: "service",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(JSON.stringify(["service.online", "opaque-variant"]));
  });

  test("strips remote images from public markdown", () => {
    expect(sanitizePublicDashboardMarkdown("Before ![secret](https://example.com/a.png) after")).toBe("Before  after");
    expect(sanitizePublicDashboardMarkdown('Before <img src="https://example.com/a.png" alt="secret"> after')).toBe("Before  after");
  });
});
