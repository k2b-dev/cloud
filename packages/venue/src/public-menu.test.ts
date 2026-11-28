import { describe, expect, test } from "bun:test";
import { MAX_PUBLIC_MENU_ITEMS, MAX_PUBLIC_SECTIONS, type PublicSection } from "./contracts";
import { capPublicSections, filterPublicMenuSections, isPublicMenuItemAvailable } from "./public-menu";

const item = (availability: { availableFrom?: string | null; availableUntil?: string | null } = {}) => ({
  name: "Lunch special",
  ...availability,
});

const menuSection = (items: unknown[]): PublicSection => ({
  id: "section-1",
  venueId: "venue-1",
  kind: "menu",
  title: "Menu",
  content: { items },
  enabled: true,
  position: 1,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

describe("public menu availability", () => {
  test("treats start and end dates as inclusive", () => {
    const scheduled = item({ availableFrom: "2026-07-13", availableUntil: "2026-07-15" });

    expect(isPublicMenuItemAvailable(scheduled, "2026-07-12")).toBe(false);
    expect(isPublicMenuItemAvailable(scheduled, "2026-07-13")).toBe(true);
    expect(isPublicMenuItemAvailable(scheduled, "2026-07-15")).toBe(true);
    expect(isPublicMenuItemAvailable(scheduled, "2026-07-16")).toBe(false);
  });

  test("supports one-sided and unlimited availability", () => {
    expect(isPublicMenuItemAvailable(item(), "2026-07-13")).toBe(true);
    expect(isPublicMenuItemAvailable(item({ availableFrom: "2026-07-14" }), "2026-07-13")).toBe(false);
    expect(isPublicMenuItemAvailable(item({ availableUntil: "2026-07-12" }), "2026-07-13")).toBe(false);
  });

  test("filters only public menu item copies and fails closed for malformed schedules", () => {
    const original = menuSection([item(), item({ availableFrom: "2026-07-14" }), { name: "Broken", availableFrom: "tomorrow" }]);
    const [filtered] = filterPublicMenuSections([original], "2026-07-13");

    expect(filtered?.content.items).toEqual([item()]);
    expect(original.content.items).toHaveLength(3);
  });

  test("hides a public menu section while none of its items are available", () => {
    const sections = filterPublicMenuSections([menuSection([item({ availableFrom: "2026-07-14" })])], "2026-07-13");

    expect(sections).toEqual([]);
  });
});

describe("public page limits", () => {
  const notice = (index: number): PublicSection => ({ ...menuSection([]), id: `notice-${index}`, kind: "notice", content: { text: "Hi" } });

  test("keeps a page within its limits as it is", () => {
    const sections = [notice(0), menuSection(Array.from({ length: MAX_PUBLIC_MENU_ITEMS }, () => item()))];
    expect(capPublicSections(sections)).toEqual(sections);
  });

  test("cuts a page saved before the limits to the first sections and the first menu items", () => {
    const half = Math.ceil(MAX_PUBLIC_MENU_ITEMS / 2) + 1;
    const first = { ...menuSection(Array.from({ length: half }, () => item())), id: "menu-1" };
    const second = { ...menuSection(Array.from({ length: half }, () => item())), id: "menu-2" };
    const third = { ...menuSection([item()]), id: "menu-3" };
    const notices = Array.from({ length: MAX_PUBLIC_SECTIONS }, (_, index) => notice(index));
    const capped = capPublicSections([first, second, third, ...notices]);

    expect(capped).toHaveLength(MAX_PUBLIC_SECTIONS - 1);
    expect(capped.map((section) => section.id).slice(0, 3)).toEqual(["menu-1", "menu-2", "notice-0"]);
    expect(capped[0]?.content.items).toHaveLength(half);
    expect(capped[1]?.content.items).toHaveLength(MAX_PUBLIC_MENU_ITEMS - half);
    expect(first.content.items).toHaveLength(half);
  });
});
