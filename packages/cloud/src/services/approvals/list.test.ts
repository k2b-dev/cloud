import { expect, test } from "bun:test";
import {
  APPROVALS_PAGE_SIZE,
  ApprovalCountsSchema,
  ApprovalDecisionInputSchema,
  ApprovalListQuerySchema,
  ApprovalPageSchema,
} from "../../contracts/approvals";
import { decodeApprovalCursor, encodeApprovalCursor } from "./cursor";
import { type PendingApprovalRow, presentPendingApproval } from "./list";

const row: PendingApprovalRow = {
  id: crypto.randomUUID(),
  appId: "mail",
  action: "draft.send",
  argsDigest: "stored-digest",
  requesterAppId: "assistant",
  assurance: "standard",
  sentence: "Mail: Send draft",
  details: { message: "Send it?" },
  createdAt: new Date(),
  expiresAt: new Date(),
  cursorCreatedAt: "2026-10-11T10:00:00.123456Z",
  conversationShortId: "ab12345678",
  conversationTitle: "Send a letter",
  requesterTitle: "Send a letter",
  allowChat: null,
  allowAlways: true,
  rememberToolName: null,
  toolName: "mail.draft.send",
  runConfig: { kind: "chat", input: "Send" },
};

test("approval cursors preserve timestamp precision and reject malformed input", () => {
  const cursor = { createdAt: row.cursorCreatedAt, id: row.id };
  expect(decodeApprovalCursor(encodeApprovalCursor(cursor))).toEqual(cursor);
  for (const invalid of ["", "!", "e30", "x".repeat(201), Buffer.from(JSON.stringify({ ...cursor, id: "bad" })).toString("base64url")])
    expect(decodeApprovalCursor(invalid)).toBeNull();
});

test("the presenter uses registry presentation, validates reviews, and applies chat remember policy", () => {
  const approval = presentPendingApproval(row, []);
  expect(presentPendingApproval(row, [{ id: "mail", name: "Post", icon: "ti ti-mail" }]).app).toEqual({
    id: "mail",
    name: "Post",
    icon: "ti ti-mail",
  });
  expect(approval.app).toEqual({ id: "mail", name: "mail", icon: null });
  expect(approval.requester).toEqual({
    kind: "chat",
    appId: "assistant",
    title: "Send a letter",
    href: "/app/assistant?conversation=ab12345678",
  });
  expect(approval.remember).toEqual({ chat: true, always: true, website: false });
  expect(
    presentPendingApproval({ ...row, details: { bad: true }, assurance: "confirm", rememberToolName: "website:read" }, []).remember,
  ).toEqual({ chat: false, always: false, website: true });
  expect(presentPendingApproval({ ...row, details: { bad: true } }, []).review).toBeNull();
  expect(presentPendingApproval({ ...row, allowChat: false }, []).remember.chat).toBe(false);
});

test("the supplied approval contract bounds pages and validates decisions and counts", () => {
  const item = presentPendingApproval(row, []);
  expect(ApprovalPageSchema.safeParse({ items: [item], nextCursor: null, count: 1, elsewhere: 0 }).success).toBe(true);
  expect(
    ApprovalPageSchema.safeParse({
      items: Array.from({ length: APPROVALS_PAGE_SIZE + 1 }, () => item),
      nextCursor: null,
      count: 21,
      elsewhere: 0,
    }).success,
  ).toBe(false);
  expect(ApprovalListQuerySchema.safeParse({ app: "mail", link: "/app/mail?draft=one", cursor: "cursor" }).success).toBe(true);
  expect(ApprovalListQuerySchema.safeParse({ link: "https://example.test" }).success).toBe(false);
  expect(ApprovalListQuerySchema.safeParse({ limit: 100 }).success).toBe(false);
  expect(ApprovalDecisionInputSchema.safeParse({ approved: true, remember: "chat" }).success).toBe(true);
  expect(ApprovalDecisionInputSchema.safeParse({ approved: true, remember: "website" }).success).toBe(false);
  expect(ApprovalCountsSchema.safeParse({ total: 2, apps: { mail: 2, assistant: 2 } }).success).toBe(true);
  expect(ApprovalCountsSchema.safeParse({ total: 2, apps: { mail: 0 } }).success).toBe(false);
});
