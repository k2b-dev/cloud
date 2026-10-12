import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDomTestHarness, type DomTestHarness } from "../../../../../../ui/test/dom";
import {
  requestSpacesDetailStep,
  SPACES_DETAIL_NAVIGATION_EVENT,
  SPACES_DETAIL_STEP_EVENT,
  type SpacesDetailNavigation,
  type SpacesDetailStep,
  subscribeToSpacesDetailStep,
} from "./workspace-events";

let dom: DomTestHarness;
let cleanups: (() => void)[];
let navigation: SpacesDetailNavigation[];
beforeEach(() => {
  dom = createDomTestHarness();
  cleanups = [];
  navigation = [];
  const record = (event: Event) => {
    if (event instanceof CustomEvent) navigation.push(event.detail);
  };
  window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, record);
  cleanups.push(() => window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, record));
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  dom.cleanup();
});

const link = (itemId: string, occurrenceId?: string) => {
  const anchor = document.createElement("a");
  const url = new URL(window.location.href);
  url.searchParams.set("item", itemId);
  if (occurrenceId) url.searchParams.set("occurrence", occurrenceId);
  anchor.href = `${url.pathname}${url.search}`;
  anchor.textContent = itemId;
  dom.root.append(anchor);
  return anchor;
};
const step = (direction: 1 | -1, itemId: string | null, occurrenceId: string | null = null) =>
  requestSpacesDetailStep(direction, { itemId, occurrenceId });
const subscribe = (links: () => HTMLAnchorElement[], opened?: (anchor: HTMLAnchorElement) => void) => {
  const unsubscribe = subscribeToSpacesDetailStep(links, opened);
  cleanups.push(unsubscribe);
  return unsubscribe;
};

test("steps in supplied DOM order, replaces history, calls opened, and never wraps", () => {
  const anchors = [link("Third"), link("First"), link("Second")];
  const opened: HTMLAnchorElement[] = [];
  subscribe(
    () => anchors,
    (anchor) => opened.push(anchor),
  );
  expect(step(1, "Third")).toBe(anchors[1]);
  expect(navigation).toEqual([{ href: "/?item=First", itemId: "First", occurrenceId: null, history: "replace", reconcile: undefined }]);
  expect(opened[0]).toBe(anchors[1]);
  expect(step(-1, "First")).toBe(anchors[0]);
  expect(step(-1, "Third")).toBeUndefined();
  expect(step(1, "Second")).toBeUndefined();
  expect(navigation).toHaveLength(2);
});

test("uses the first or last currently loaded link when selection is absent, and handles an empty view", () => {
  let anchors = [link("First"), link("Last")];
  subscribe(() => anchors);
  expect(step(1, "Hidden")).toBe(anchors[0]);
  expect(step(-1, "Hidden")).toBe(anchors[1]);
  expect(step(1, null)).toBe(anchors[0]);
  anchors = [];
  expect(step(1, "Hidden")).toBeUndefined();
  expect(step(-1, "Hidden")).toBeUndefined();
  expect(navigation).toHaveLength(3);
});

test("matches item and occurrence together, including a missing occurrence", () => {
  const anchors = [link("Series"), link("Series", "2026-10-12"), link("Series", "2026-10-13"), link("Last")];
  subscribe(() => anchors);
  expect(step(1, "Series", "2026-10-12")).toBe(anchors[2]);
  expect(navigation[0]?.occurrenceId).toBe("2026-10-13");
  expect(step(-1, "Series", "2026-10-12")).toBe(anchors[0]);
  expect(navigation[1]?.occurrenceId).toBeNull();
  expect(step(1, "Series")).toBe(anchors[1]);
});

test("prefers the focused duplicate, then the last opened duplicate, then the first", () => {
  const first = link("Duplicate");
  const between = link("Between");
  const second = link("Duplicate");
  const last = link("Last");
  subscribe(() => [first, between, second, last]);
  expect(step(1, "Duplicate")).toBe(between);
  const child = document.createElement("span");
  child.tabIndex = 0;
  second.append(child);
  child.focus();
  expect(step(1, "Duplicate")).toBe(last);
  child.blur();
  expect(step(-1, "Last")).toBe(second);
  expect(step(-1, "Duplicate")).toBe(between);
  first.focus();
  expect(step(1, "Between")).toBe(second);
  expect(step(-1, "Duplicate")).toBeUndefined();
});

test("ignores an answered event, lets only one subscription answer, and unsubscribes", () => {
  const first = link("First");
  const next = link("Next");
  const unsubscribe = subscribe(() => [first, next]);
  subscribe(() => [first, link("Other")]);
  const answered: SpacesDetailStep = { direction: 1, itemId: "First", occurrenceId: null, target: first };
  window.dispatchEvent(new CustomEvent(SPACES_DETAIL_STEP_EVENT, { detail: answered }));
  expect(navigation).toEqual([]);
  expect(step(1, "First")).toBe(next);
  expect(navigation).toHaveLength(1);
  unsubscribe();
  expect(step(1, "First")?.textContent).toBe("Other");
});

test("does not open a destination without an href", () => {
  const first = link("First");
  const missing = document.createElement("a");
  subscribe(() => [first, missing]);
  expect(step(1, "First")).toBeUndefined();
  expect(navigation).toEqual([]);
});
