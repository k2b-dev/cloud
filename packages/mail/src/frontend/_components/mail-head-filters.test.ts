import { expect, test } from "bun:test";
import type { MailSearchExpression } from "../../contracts";
import { resolveMailSearchRoute } from "../../search-state";
import {
  emptyMailHeadFilters,
  mailHeadFilterDayCount,
  mailHeadFilterDays,
  mailHeadFilterHref,
  readMailHeadFilters,
} from "./mail-head-filters";
import { buildMailSearchClearHref, buildMailSearchHref } from "./mail-navigation";

const origin = new URL("https://cloud.test/app/mail/Box001?folder=Fold01&conversation=Conv01");
const read = (href: string) => {
  const url = new URL(href, origin);
  return readMailHeadFilters(url, resolveMailSearchRoute(url), url.searchParams.get("folder"));
};
test("folder quick filters constrain both the message and its flag placement, including after reload", () => {
  const filters = { ...emptyMailHeadFilters("Fold01"), unread: true, flagged: true, attachment: true };
  const href = mailHeadFilterHref(origin, filters);
  const url = new URL(href, origin);
  expect(url.searchParams.get("folder")).toBe("Fold01");
  expect(resolveMailSearchRoute(url).expression).toEqual({
    type: "and",
    expressions: [
      { type: "folder_id", folderId: "Fold01" },
      { type: "unread", folderId: "Fold01" },
      { type: "flagged", folderId: "Fold01" },
      { type: "size", field: "attachment", operator: "at_least", bytes: 0 },
    ],
  });
  expect(read(href)).toEqual(filters);
  expect(buildMailSearchClearHref(url)).toBe(origin.pathname + origin.search);
});
test("a tag retains folder scope and other filters while selecting the existing All tab", () => {
  const first = new URL(mailHeadFilterHref(origin, { ...emptyMailHeadFilters("Fold01"), unread: true }), origin);
  const filters = { ...read(first.href)!, tagId: "Tag001" };
  const href = mailHeadFilterHref(first, filters);
  const tagged = new URL(href, origin);
  expect(tagged.searchParams.has("folder")).toBe(false);
  expect(read(href)).toEqual(filters);
  expect(buildMailSearchClearHref(tagged)).toBe(origin.pathname + origin.search);
  const untagged = new URL(mailHeadFilterHref(tagged, { ...filters, tagId: null }), origin);
  expect(untagged.searchParams.get("folder")).toBe("Fold01");
  expect(mailHeadFilterHref(untagged, emptyMailHeadFilters("Fold01"))).toBe(origin.pathname + origin.search);
});
test("text search from a quick-filtered folder remains mailbox-wide and keeps the original return target", () => {
  const filtered = new URL(mailHeadFilterHref(origin, { ...emptyMailHeadFilters("Fold01"), unread: true }), origin);
  const url = new URL(buildMailSearchHref(filtered, { q: "invoice" }), origin);
  expect(resolveMailSearchRoute(url).expression).toEqual({ type: "text", field: "any", match: "words", query: "invoice" });
  expect(read(url.href)).toBeNull();
  expect(buildMailSearchClearHref(url)).toBe(origin.pathname + origin.search);
});
test("unscoped flags, mismatched placements, nested OR and duplicate leaves remain advanced searches", () => {
  const folder: MailSearchExpression = { type: "folder_id", folderId: "Fold01" };
  const unread: MailSearchExpression = { type: "unread", folderId: "Fold01" };
  for (const expression of [
    { type: "and", expressions: [folder, { type: "unread" }] },
    { type: "and", expressions: [folder, { type: "unread", folderId: "Fold02" }] },
    { type: "or", expressions: [folder, unread] },
    { type: "and", expressions: [folder, unread, unread] },
    { type: "not", expression: unread },
  ] satisfies MailSearchExpression[]) {
    expect(read(buildMailSearchHref(origin, { search: JSON.stringify({ expression, sort: "newest" }) }))).toBeNull();
  }
});
test("date presets keep fixed bounds and all other conditions across serialization", () => {
  for (const days of [7, 30] as const) {
    const dates = mailHeadFilterDays(days, Date.parse("2026-10-14T10:00:00Z"));
    const filters = { ...emptyMailHeadFilters("Fold01"), flagged: true, dates };
    expect(read(mailHeadFilterHref(origin, filters))).toEqual(filters);
    expect(mailHeadFilterDayCount(dates)).toBe(days);
    expect(dates[1]!.value).toBe("2026-10-14T10:00:00.000Z");
  }
});
test("root tags stay unscoped; invalid searches and saved views are not flattened", () => {
  const root = new URL(origin.pathname, origin);
  expect(read(mailHeadFilterHref(root, { ...emptyMailHeadFilters(null), tagId: "Tag001" }))?.folderId).toBeNull();
  expect(read(`${root.pathname}?search=invalid`)).toBeNull();
  expect(read(`${root.pathname}?savedView=Saved1`)).toBeNull();
});

test("clearing a direct chip link never resurrects conditions removed in earlier steps", () => {
  const initial = { ...emptyMailHeadFilters("Fold01"), unread: true, flagged: true };
  const direct = new URL(mailHeadFilterHref(origin, initial), origin);
  direct.searchParams.delete("searchFrom");
  const unreadOnly = new URL(mailHeadFilterHref(direct, { ...initial, flagged: false }, initial), origin);
  const clear = new URL(mailHeadFilterHref(unreadOnly, emptyMailHeadFilters("Fold01"), { ...initial, flagged: false }), origin);
  expect(clear.searchParams.get("folder")).toBe("Fold01");
  expect(clear.searchParams.has("search")).toBe(false);
  expect(read(clear.href)).toEqual(emptyMailHeadFilters("Fold01"));
});
test("initial chips consume the effective folder instead of reinterpreting mixed route parameters", () => {
  const url = new URL("?view=mine&folder=Fold01", origin);
  expect(readMailHeadFilters(url, resolveMailSearchRoute(url), null)?.folderId).toBeNull();
  url.searchParams.set("view", "invalid");
  expect(readMailHeadFilters(url, resolveMailSearchRoute(url), "Fold01")?.folderId).toBe("Fold01");
});
