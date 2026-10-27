import { expect, test } from "bun:test";
import { createSpacesNavigationItems, orderSidebarSpaces } from "./spaces-navigation";

const spaces = [
  { id: "First01", name: "First", color: "#fff", description: null, openItemCount: 2 },
  { id: "Other01", name: "Other", color: "#000", description: "Other work", openItemCount: 1 },
  { id: "Last001", name: "Last", color: "#111", description: null, openItemCount: 0 },
];

test("pins precede unpinned Spaces in stored order without changing the input", () => {
  expect(orderSidebarSpaces(spaces, ["Last001", "missing", "Other01"]).map((space) => space.id)).toEqual(["Last001", "Other01", "First01"]);
  expect(spaces.map((space) => space.id)).toEqual(["First01", "Other01", "Last001"]);
});

test("phone navigation contains My work, the calendar of all Spaces, and every Space with exactly the current Space active", () => {
  const items = createSpacesNavigationItems({
    spaces,
    pinnedSpaceIds: ["Other01"],
    current: { kind: "space", id: "First01" },
    canCreate: true,
    myWorkLabel: "My work",
    calendarLabel: "Calendar",
    newSpaceLabel: "New space",
  });
  expect(items.map(({ id }) => id)).toEqual(["my-work", "all-calendars", "Other01", "First01", "Last001", "new-space"]);
  expect(items.filter(({ active }) => active).map(({ id }) => id)).toEqual(["First01"]);
  expect(items[0]?.href).toBe("/app/spaces");
  expect(items.at(-1)?.action).toBe("new-space");
  expect(items.some(({ id }) => ["search", "settings", "ical", "list", "kanban", "table", "calendar"].includes(id))).toBe(false);
});

test("overview marks My work and hides creation when it is not allowed", () => {
  const items = createSpacesNavigationItems({
    spaces,
    pinnedSpaceIds: [],
    current: { kind: "overview" },
    canCreate: false,
    myWorkLabel: "Meine Arbeit",
    calendarLabel: "Kalender",
    newSpaceLabel: "Neuer Space",
  });
  expect(items.filter(({ active }) => active).map(({ label }) => label)).toEqual(["Meine Arbeit"]);
  expect(items.some(({ action }) => action === "new-space")).toBe(false);
});

test("the calendar page marks Calendar, right below My work", () => {
  const items = createSpacesNavigationItems({
    spaces,
    pinnedSpaceIds: [],
    current: { kind: "calendar" },
    canCreate: true,
    myWorkLabel: "Meine Arbeit",
    calendarLabel: "Kalender",
    newSpaceLabel: "Neuer Space",
  });
  expect(items.slice(0, 2).map(({ label }) => label)).toEqual(["Meine Arbeit", "Kalender"]);
  expect(items.filter(({ active }) => active).map(({ href }) => href)).toEqual(["/app/spaces/calendar"]);
});
