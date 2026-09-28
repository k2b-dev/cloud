import { describe, expect, test } from "bun:test";
import type { MailSearchExpression } from "./contracts";
import {
  MAIL_SEARCH_MATCHES_NOTHING,
  MAIL_SEARCH_PARAMETER,
  MAX_MAIL_SEARCH_PARAMETER_LENGTH,
  mailSearchReferences,
  parseMailQuickSearchFields,
  parseMailSearchState,
  replaceMailSearchReferences,
  resolveMailSearchRoute,
  serializeMailSearchState,
  simpleMailSearchExpression,
} from "./search-state";

const nestedExpression: MailSearchExpression = {
  type: "and",
  expressions: [
    { type: "text", field: "subject", query: "quarterly report", match: "phrase" },
    {
      type: "or",
      expressions: [
        { type: "text", field: "from", query: "finance@example.com", match: "exact" },
        { type: "not", expression: { type: "work_status", value: "done" } },
      ],
    },
    { type: "date", field: "internal_date", operator: "on_or_after", value: "2026-07-01T00:00:00.000Z" },
  ],
};

describe("Mail search URL state", () => {
  test("round-trips the canonical recursive expression and sort", () => {
    const serialized = serializeMailSearchState({ expression: nestedExpression, sort: "newest" });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const url = new URL("https://cloud.example/app/mail/00000000-0000-4000-8000-000000000000");
    url.searchParams.set(MAIL_SEARCH_PARAMETER, serialized.value);
    expect(parseMailSearchState(url)).toEqual({
      state: { expression: nestedExpression, sort: "newest" },
      error: null,
    });
  });

  test("rejects malformed and schema-invalid values without throwing", () => {
    const malformed = new URL("https://cloud.example/app/mail/id?search=%7B");
    expect(parseMailSearchState(malformed)).toEqual({ state: null, error: "The search link is malformed." });

    const invalid = new URL("https://cloud.example/app/mail/id");
    invalid.searchParams.set(MAIL_SEARCH_PARAMETER, JSON.stringify({ expression: { type: "unknown" }, sort: "newest" }));
    expect(parseMailSearchState(invalid)).toEqual({
      state: null,
      error: "The search link contains an invalid condition.",
    });
  });

  test("rejects search state that exceeds the workspace URL budget", () => {
    const expression: MailSearchExpression = {
      type: "and",
      expressions: Array.from({ length: 20 }, (_, index) => ({
        type: "text" as const,
        field: "body" as const,
        query: `${index}-${"x".repeat(450)}`,
        match: "contains" as const,
      })),
    };
    const serialized = serializeMailSearchState({ expression, sort: "relevance" });
    expect(serialized).toEqual({
      ok: false,
      error: "The search is too large to keep in the mailbox URL. Remove or shorten a condition.",
    });

    const url = new URL("https://cloud.example/app/mail/id");
    url.searchParams.set(MAIL_SEARCH_PARAMETER, "x".repeat(MAX_MAIL_SEARCH_PARAMETER_LENGTH + 1));
    expect(parseMailSearchState(url)).toEqual({ state: null, error: "The search link is invalid or too large." });
  });

  test("keeps simple query search as a canonical text expression", () => {
    expect(simpleMailSearchExpression("  invoice  ")).toEqual({
      type: "text",
      field: "any",
      query: "invoice",
      match: "words",
    });
    expect(simpleMailSearchExpression(" ")).toBeNull();
  });

  test("parses unique canonical quick-search fields and ignores invalid values", () => {
    expect(parseMailQuickSearchFields(new URL("https://cloud.example/app/mail/id?qFields=subject,from,subject,invalid"))).toEqual([
      "subject",
      "from",
    ]);
    expect(parseMailQuickSearchFields(new URL("https://cloud.example/app/mail/id?qFields=invalid"))).toEqual([]);
    expect(parseMailQuickSearchFields(new URL("https://cloud.example/app/mail/id"))).toEqual([]);
  });

  test("combines selected quick-search fields into one canonical expression", () => {
    expect(simpleMailSearchExpression(" invoice ", ["from", "recipients"])).toEqual({
      type: "or",
      expressions: [
        { type: "text", field: "from", query: "invoice", match: "words" },
        { type: "text", field: "recipients", query: "invoice", match: "words" },
      ],
    });
    expect(simpleMailSearchExpression("invoice", ["attachment_name"])).toEqual({
      type: "text",
      field: "attachment_name",
      query: "invoice",
      match: "words",
    });
    expect(simpleMailSearchExpression("invoice", [])).toEqual(simpleMailSearchExpression("invoice"));
  });

  test("resolves simple and structured routes with deterministic precedence", () => {
    const simple = new URL("https://cloud.example/app/mail/id?q=invoice");
    expect(resolveMailSearchRoute(simple)).toEqual({
      query: "invoice",
      expression: {
        type: "text",
        field: "any",
        query: "invoice",
        match: "words",
      },
      sort: "relevance",
      error: null,
    });

    const scoped = new URL("https://cloud.example/app/mail/id?q=invoice&qFields=from,attachment_name");
    expect(resolveMailSearchRoute(scoped)).toEqual({
      query: "invoice",
      expression: {
        type: "or",
        expressions: [
          { type: "text", field: "from", query: "invoice", match: "words" },
          { type: "text", field: "attachment_name", query: "invoice", match: "words" },
        ],
      },
      sort: "relevance",
      error: null,
    });

    const serialized = serializeMailSearchState({ expression: nestedExpression, sort: "newest" });
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const structured = new URL("https://cloud.example/app/mail/id?q=ignored");
    structured.searchParams.set(MAIL_SEARCH_PARAMETER, serialized.value);
    expect(resolveMailSearchRoute(structured)).toEqual({
      query: "ignored",
      expression: nestedExpression,
      sort: "newest",
      error: null,
    });
  });

  test("fails closed for oversized simple query links", () => {
    const url = new URL("https://cloud.example/app/mail/id");
    url.searchParams.set("q", "x".repeat(501));
    expect(resolveMailSearchRoute(url)).toEqual({
      query: "x".repeat(501),
      expression: null,
      sort: "relevance",
      error: "The search query is invalid or too long.",
    });
  });

  test("replaces only folder and tag conditions, however deeply they are nested", () => {
    const expression: MailSearchExpression = {
      type: "or",
      expressions: [
        { type: "not", expression: { type: "local_tag_id", tagId: "Tag001" } },
        {
          type: "and",
          expressions: [
            { type: "folder_id", folderId: "Fold01" },
            { type: "snoozed", value: false },
          ],
        },
      ],
    };
    expect(mailSearchReferences(expression)).toEqual([
      { type: "local_tag_id", tagId: "Tag001" },
      { type: "folder_id", folderId: "Fold01" },
    ]);
    expect(
      replaceMailSearchReferences(expression, (reference) =>
        reference.type === "folder_id" ? { ...reference, folderId: "internal-folder" } : MAIL_SEARCH_MATCHES_NOTHING,
      ),
    ).toEqual({
      type: "or",
      expressions: [
        { type: "not", expression: MAIL_SEARCH_MATCHES_NOTHING },
        {
          type: "and",
          expressions: [
            { type: "folder_id", folderId: "internal-folder" },
            { type: "snoozed", value: false },
          ],
        },
      ],
    });
  });
});
