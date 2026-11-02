import { describe, expect, test } from "bun:test";
import type { MailSearchExpression } from "./contracts";
import { mailListingOpenOnly, mailSearchOpenWorkTerms, OPEN_WORK_EXPRESSION, withOpenWork } from "./folder-display-rules";

const scope = (overrides: Partial<Parameters<typeof mailListingOpenOnly>[0]> = {}) => ({
  activeView: null,
  explicitStatus: false,
  textSearch: false,
  folderRoles: [],
  ...overrides,
});

describe("work lists show open conversations only", () => {
  test.each([
    ["All mail", scope(), true],
    ["the Inbox", scope({ folderRoles: ["inbox"] }), true],
    ["an own folder", scope({ folderRoles: ["other"] }), true],
    ["a tag, filter or saved view without status", scope(), true],
    ["Archive", scope({ folderRoles: ["archive"] }), false],
    ["Sent", scope({ folderRoles: ["sent"] }), false],
    ["Trash", scope({ folderRoles: ["trash"] }), false],
    ["Junk", scope({ folderRoles: ["junk"] }), false],
    ["All Mail", scope({ folderRoles: ["all"] }), false],
    ["a filter across the Inbox and Archive", scope({ folderRoles: ["inbox", "archive"] }), false],
    ["an explicit status", scope({ explicitStatus: true }), false],
    ["a text search", scope({ textSearch: true }), false],
    ["the Done view", scope({ activeView: "done" }), false],
    ["the Needs action view", scope({ activeView: "needs_action" }), false],
  ] as const)("%s → %p", (_name, listing, expected) => {
    expect(mailListingOpenOnly(listing)).toBe(expected);
  });

  test("a search names its status, text and folder conditions wherever they are nested", () => {
    const expression: MailSearchExpression = {
      type: "and",
      expressions: [
        { type: "local_tag_id", tagId: "11111111-1111-4111-8111-111111111111" },
        { type: "or", expressions: [{ type: "folder_id", folderId: "22222222-2222-4222-8222-222222222222" }, { type: "unread" }] },
      ],
    };
    expect(mailSearchOpenWorkTerms(expression)).toEqual({
      status: false,
      text: false,
      folderIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(mailSearchOpenWorkTerms({ type: "not", expression: { type: "work_status", value: "done" } }).status).toBe(true);
    expect(mailSearchOpenWorkTerms({ type: "snoozed", value: true }).status).toBe(true);
    expect(mailSearchOpenWorkTerms({ type: "text", field: "any", query: "invoice", match: "words" }).text).toBe(true);
  });

  test("the search form of the rule leaves out done and snoozed conversations", () => {
    expect(withOpenWork({ type: "flagged" })).toEqual({ type: "and", expressions: [{ type: "flagged" }, OPEN_WORK_EXPRESSION] });
    expect(mailSearchOpenWorkTerms(OPEN_WORK_EXPRESSION).status).toBe(true);
  });
});
