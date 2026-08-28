import { describe, expect, test } from "bun:test";
import type { MailSearchExpression } from "../../contracts";
import {
  appendMailSearchExpression,
  countMailSearchNodes,
  ensureMailSearchRootGroup,
  MAIL_SEARCH_FIELD_GROUPS,
  MAIL_SEARCH_FIELD_OPTIONS,
  mailSearchExpressionDepth,
  mailSearchFieldOptionsFor,
  normalizeMailSearchExpression,
  removeMailSearchExpression,
  summarizeMailSearchExpression,
  toggleMailSearchNegation,
  updateMailSearchExpression,
} from "./mail-search-builder-model";

const root: MailSearchExpression = {
  type: "and",
  expressions: [
    { type: "text", field: "subject", query: "invoice", match: "words" },
    {
      type: "or",
      expressions: [
        { type: "work_status", value: "needs_action" },
        { type: "work_status", value: "waiting" },
      ],
    },
  ],
};

describe("Mail search builder model", () => {
  test("groups fields into the complete overlapping search taxonomy", () => {
    expect(MAIL_SEARCH_FIELD_GROUPS.map((group) => group.label)).toEqual([
      "Recommended",
      "Content",
      "People",
      "Mailbox",
      "Date & size",
      "Technical",
    ]);
    expect(MAIL_SEARCH_FIELD_OPTIONS.find((option) => option.id === "assignee")?.groups).toEqual(["recommended", "people", "mailbox"]);
    expect(MAIL_SEARCH_FIELD_OPTIONS.find((option) => option.id === "text:reference")?.groups).toEqual(["content", "technical"]);
    expect(MAIL_SEARCH_FIELD_OPTIONS.every((option) => option.groups.length > 0)).toBe(true);
  });

  test("hides provider keywords from new conditions but preserves existing searches", () => {
    expect(mailSearchFieldOptionsFor({ type: "all" }).map((option) => option.id)).not.toContain("text:keyword");
    const keywordSearch: MailSearchExpression = { type: "text", field: "keyword", query: "Legacy", match: "words" };
    expect(mailSearchFieldOptionsFor(keywordSearch).map((option) => option.id)).toContain("text:keyword");
    expect(summarizeMailSearchExpression(keywordSearch)).toBe("Provider keyword contains all words “Legacy”");
  });

  test("updates nested nodes without mutating siblings", () => {
    const updated = updateMailSearchExpression(root, [1, 0], () => ({
      type: "work_status",
      value: "done",
    }));
    expect(updated).not.toBe(root);
    expect(updated).toEqual({
      ...root,
      expressions: [
        root.expressions[0]!,
        {
          type: "or",
          expressions: [
            { type: "work_status", value: "done" },
            { type: "work_status", value: "waiting" },
          ],
        },
      ],
    });
    expect(root.expressions[1]).toEqual({
      type: "or",
      expressions: [
        { type: "work_status", value: "needs_action" },
        { type: "work_status", value: "waiting" },
      ],
    });
  });

  test("preserves nested paths through NOT wrappers", () => {
    const negated = toggleMailSearchNegation(root, [1]);
    const updated = updateMailSearchExpression(negated, [1, 1], () => ({
      type: "work_status",
      value: "done",
    }));
    expect(updated).toEqual({
      ...root,
      expressions: [
        root.expressions[0]!,
        {
          type: "not",
          expression: {
            type: "or",
            expressions: [
              { type: "work_status", value: "needs_action" },
              { type: "work_status", value: "done" },
            ],
          },
        },
      ],
    });
  });

  test("adds and removes conditions while keeping non-empty groups", () => {
    const appended = appendMailSearchExpression(root, [1], {
      type: "snoozed",
      value: true,
    });
    expect(countMailSearchNodes(appended)).toBe(6);
    expect(removeMailSearchExpression(appended, [1, 2])).toEqual(root);

    const single: MailSearchExpression = {
      type: "and",
      expressions: [{ type: "work_status", value: "needs_action" }],
    };
    expect(removeMailSearchExpression(single, [0])).toEqual(single);
  });

  test("normalizes leaf roots and produces a readable boolean summary", () => {
    expect(
      ensureMailSearchRootGroup({
        type: "not",
        expression: {
          type: "text",
          field: "from",
          query: "alerts",
          match: "contains",
        },
      }),
    ).toEqual({
      type: "and",
      expressions: [
        {
          type: "not",
          expression: {
            type: "text",
            field: "from",
            query: "alerts",
            match: "contains",
          },
        },
      ],
    });
    expect(summarizeMailSearchExpression(root)).toBe(
      "(Subject contains all words “invoice”) and ((Work status: Needs action) or (Work status: Waiting for reply))",
    );
    expect(summarizeMailSearchExpression(root, "de-CH")).toBe(
      "(Betreff enthält alle Wörter “invoice”) und ((Bearbeitungsstatus: Handlungsbedarf) oder (Bearbeitungsstatus: Wartet auf Antwort))",
    );
  });

  test("measures NOT wrappers as search depth and nodes", () => {
    const nested = toggleMailSearchNegation(root, [1]);
    expect(mailSearchExpressionDepth(nested)).toBe(4);
    expect(countMailSearchNodes(nested)).toBe(6);
  });

  test("removes incomplete text rows before submission", () => {
    expect(
      normalizeMailSearchExpression({
        type: "and",
        expressions: [
          { type: "text", field: "any", query: "   ", match: "words" },
          {
            type: "or",
            expressions: [
              { type: "text", field: "subject", query: " invoice ", match: "words" },
              { type: "not", expression: { type: "text", field: "body", query: "", match: "contains" } },
            ],
          },
        ],
      }),
    ).toEqual({
      type: "and",
      expressions: [
        {
          type: "or",
          expressions: [{ type: "text", field: "subject", query: "invoice", match: "words" }],
        },
      ],
    });
    expect(normalizeMailSearchExpression({ type: "text", field: "any", query: "", match: "words" })).toEqual({ type: "all" });
  });
});
