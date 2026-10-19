import { expect, test } from "bun:test";
import { collectRecentSentResourceRefs } from "./recent-sent-refs";
import { aiResourceMarker } from "./resource-markers";

const marker = (id: string) =>
  aiResourceMarker({ ref: { type: "demo.item", id }, title: "Stored secret", icon: "ti ti-secret", href: "/secret" });
const row = (markers: string[], conversationId = "latest") => ({ markers, conversationId, lastSentAt: "2026-10-01T00:00:00.000Z" });

test("parses only schema-valid markers and emits identity without stored metadata", () => {
  const invalid = marker("bad").replace('"title":"Stored secret"', '"title":42');
  expect(collectRecentSentResourceRefs([row(["not a marker", invalid, "[Attached Cloud resource {}]", marker("one")])])).toEqual([
    { ref: { type: "demo.item", id: "one" }, count: 1, conversationId: "latest", lastSentAt: "2026-10-01T00:00:00.000Z" },
  ]);
});

test("deduplicates per message, counts all scanned messages, preserves latest conversation and eight-ref order", () => {
  const result = collectRecentSentResourceRefs([
    row([marker("one"), marker("one"), ...Array.from({ length: 10 }, (_, i) => marker(`item-${i}`))]),
    row([marker("one")], "older"),
    row([marker("one")], "oldest"),
  ]);
  expect(result).toHaveLength(8);
  expect(result[0]).toMatchObject({ ref: { id: "one" }, count: 3, conversationId: "latest" });
  expect(result.map((item) => item.ref.id)).toEqual(["one", "item-0", "item-1", "item-2", "item-3", "item-4", "item-5", "item-6"]);
});
