import { describe, expect, test } from "bun:test";
import { isDetailOnlySpacesNavigation, resolveCalendarNavigationHref, shouldInvalidateSpacesDetail } from "./workspace-events";
import { parseSpacesWorkspaceHref } from "./workspace-types";

const ORIGIN = "https://cloud.example";

describe("Spaces detail navigation classification", () => {
  test("enhances opening, replacing, and closing only the item parameter", () => {
    const list = "/app/spaces/one?view=list&status=active";
    expect(isDetailOnlySpacesNavigation(list, `${list}&item=item-1`, ORIGIN)).toBe(true);
    expect(isDetailOnlySpacesNavigation(`${list}&item=item-1`, `${list}&item=item-2`, ORIGIN)).toBe(true);
    expect(
      isDetailOnlySpacesNavigation(
        `${list}&item=item-1&occurrence=2026-07-17T09%3A00%3A00.000Z`,
        `${list}&item=item-1&occurrence=2026-07-18T09%3A00%3A00.000Z`,
        ORIGIN,
      ),
    ).toBe(true);
    expect(isDetailOnlySpacesNavigation(`${list}&item=item-1`, list, ORIGIN)).toBe(true);
  });

  test("leaves view, filter, path, and origin changes to document navigation", () => {
    const current = "/app/spaces/one?view=list&status=active&item=item-1";
    expect(isDetailOnlySpacesNavigation(current, "/app/spaces/one?view=kanban", ORIGIN)).toBe(false);
    expect(isDetailOnlySpacesNavigation(current, "/app/spaces/one?view=list&status=completed", ORIGIN)).toBe(false);
    expect(isDetailOnlySpacesNavigation(current, "/app/spaces/two?view=list", ORIGIN)).toBe(false);
    expect(isDetailOnlySpacesNavigation(current, "https://other.example/app/spaces/one?view=list", ORIGIN)).toBe(false);
  });
});

describe("Spaces workspace route parsing", () => {
  test("accepts only the Space workspace route", () => {
    const id = "Space1";
    expect(parseSpacesWorkspaceHref(`/app/spaces/${id}`)).toEqual({ spaceId: id });
    expect(parseSpacesWorkspaceHref(`/app/spaces/${id}/settings`)).toBeNull();
  });

  test("rejects malformed identifiers and unsupported nested routes", () => {
    expect(parseSpacesWorkspaceHref("/app/spaces/not-a-short-id")).toBeNull();
    expect(parseSpacesWorkspaceHref("/app/spaces/Space1/unknown")).toBeNull();
  });
});

describe("Spaces detail live invalidation", () => {
  test("refreshes only the selected item for item-scoped events", () => {
    expect(shouldInvalidateSpacesDetail("Item01", "Item01")).toBe(true);
    expect(shouldInvalidateSpacesDetail("Item01", "Item02")).toBe(false);
  });

  test("keeps full and local invalidations unscoped", () => {
    expect(shouldInvalidateSpacesDetail("Item01", null)).toBe(true);
    expect(shouldInvalidateSpacesDetail(null, null)).toBe(true);
  });
});

describe("Spaces calendar navigation target", () => {
  const path = "/app/spaces/Space1";

  test("keeps canonical same-space paths and queries", () => {
    expect(resolveCalendarNavigationHref(`${path}?view=calendar&cv=week&cd=2026-07-17#ignored`, ORIGIN, path)).toBe(
      `${path}?view=calendar&cv=week&cd=2026-07-17`,
    );
  });

  test("rejects cross-space, cross-origin, and malformed targets", () => {
    expect(resolveCalendarNavigationHref("/app/spaces/Space2?view=calendar", ORIGIN, path)).toBeNull();
    expect(resolveCalendarNavigationHref(`https://other.example${path}?view=calendar`, ORIGIN, path)).toBeNull();
    expect(resolveCalendarNavigationHref("http://[", ORIGIN, path)).toBeNull();
  });
});
