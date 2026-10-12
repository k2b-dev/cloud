import { expect, test } from "bun:test";
import { MAIL_SEARCH_PARAMETER, parseMailSearchState, resolveMailSearchRoute, serializeMailSearchState } from "./search-state";
import { mailExactAddressSearch, mailTagSearch } from "./search-url";

test.each(["AbCd12", "000000", "abcdef", "", "abcde", "abcdefg", "AbCd1!", " abc12", "AbCd12\n", "éabc12", "a".repeat(4_000)])(
  "tag search serialization agrees with the schema for %j",
  (tagId) => {
    expect(mailTagSearch(tagId)).toEqual(serializeMailSearchState({ expression: { type: "local_tag_id", tagId }, sort: "newest" }));
  },
);

for (const field of ["from", "participants"] as const) {
  test.each([
    "ada@example.test",
    "  ada@example.test\n",
    "",
    " \t\n",
    "a".repeat(500),
    "a".repeat(501),
    `  ${"a".repeat(500)}  `,
    `  ${"a".repeat(501)}  `,
    "Zoë@example.test",
    "🙂@example.test",
    "é".repeat(500),
    "🙂".repeat(250),
    "🙂".repeat(251),
    "🙂".repeat(500),
    "🙂".repeat(501),
    "a".repeat(4_000),
    "\u00a0ada@example.test\u00a0",
  ])(`exact ${field} search serialization agrees with the schema for %#`, (address) => {
    expect(mailExactAddressSearch(field, address)).toEqual(
      serializeMailSearchState({
        expression: { type: "text", field, query: address, match: "exact" },
        sort: "newest",
      }),
    );
  });
}

test("valid but oversized exact searches keep the encoded-size error", () => {
  expect(mailExactAddressSearch("from", "é".repeat(500))).toEqual({ ok: false, error: "too_large" });
});

test.each([
  "",
  "q=invoice",
  "q=invoice&qFields=from,subject",
  "search=",
  "search=broken&q=invoice",
  new URLSearchParams({
    search: JSON.stringify({ expression: { type: "local_tag_id", tagId: "Tag001" }, sort: "newest" }),
    q: "invoice",
  }).toString(),
  new URLSearchParams({
    search: JSON.stringify({ expression: { type: "text", field: "from", query: " ada@example.test ", match: "exact" } }),
  }).toString(),
  new URLSearchParams({ search: "a".repeat(3_001), q: "invoice" }).toString(),
  new URLSearchParams({ q: "a".repeat(501) }).toString(),
])("snapshot structured-search precedence agrees with URL parsing for %#", (query) => {
  const url = new URL(`https://cloud.test/app/mail/Box001?${query}`);
  const search = resolveMailSearchRoute(url);
  const structured =
    url.searchParams.has(MAIL_SEARCH_PARAMETER) && search.expression ? { expression: search.expression, sort: search.sort } : null;
  expect(structured).toEqual(parseMailSearchState(url).state);
});
