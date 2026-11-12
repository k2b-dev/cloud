import { expect, test } from "bun:test";
import { createCustomAppFileToken, customAppFileTokenMatchesContext, verifyCustomAppFileToken } from "./file-token";

const payload = {
  appId: "00000000-0000-4000-8000-000000000001",
  publishedAt: "2026-08-13T12:00:00.000Z",
  pageId: "catalog",
  blockId: "items",
  pageParams: { request_id: "00000000-0000-4000-8000-000000000006" },
  viewerUserId: "00000000-0000-4000-8000-000000000007",
  viewerServiceAccountId: null,
  search: "camera",
  cursor: null,
  tableId: "00000000-0000-4000-8000-000000000002",
  recordId: "00000000-0000-4000-8000-000000000003",
  fieldId: "00000000-0000-4000-8000-000000000004",
  fileId: "00000000-0000-4000-8000-000000000005",
};

test("Custom App file tokens are scoped, signed, and short-lived", () => {
  const token = createCustomAppFileToken(payload, "secret", 1_000);
  expect(verifyCustomAppFileToken(token, "secret", 1_001)).toEqual({ ...payload, expiresAt: 301_000 });
  expect(verifyCustomAppFileToken(token, "other", 1_001)).toBeNull();
  expect(verifyCustomAppFileToken(token, "secret", 301_001)).toBeNull();
  expect(verifyCustomAppFileToken(`${token}x`, "secret", 1_001)).toBeNull();
});

test("Custom App file tokens cannot be replayed across publication, page context, or viewer", () => {
  const verified = verifyCustomAppFileToken(createCustomAppFileToken(payload, "secret", 1_000), "secret", 1_001);
  expect(verified).not.toBeNull();
  if (!verified) return;

  const context = {
    appId: payload.appId,
    publishedAt: payload.publishedAt,
    pageId: payload.pageId,
    blockId: payload.blockId,
    pageParams: payload.pageParams,
    viewerUserId: payload.viewerUserId,
    viewerServiceAccountId: payload.viewerServiceAccountId,
  };
  expect(customAppFileTokenMatchesContext(verified, context)).toBe(true);
  expect(customAppFileTokenMatchesContext(verified, { ...context, publishedAt: "2026-08-13T12:01:00.000Z" })).toBe(false);
  expect(customAppFileTokenMatchesContext(verified, { ...context, pageParams: {} })).toBe(false);
  expect(customAppFileTokenMatchesContext(verified, { ...context, viewerUserId: null })).toBe(false);
  expect(
    customAppFileTokenMatchesContext(verified, {
      ...context,
      viewerServiceAccountId: "00000000-0000-4000-8000-000000000008",
    }),
  ).toBe(false);
});

test("preview tokens keep their five-minute expiry during root overlap", () => {
  const token = createCustomAppFileToken(payload, "A", 1_000);
  expect(verifyCustomAppFileToken(token, ["B", "A"], 1_001)).toMatchObject(payload);
  expect(verifyCustomAppFileToken(token, ["A", "B"], 1_001)).toMatchObject(payload);
  expect(verifyCustomAppFileToken(token, ["B", "A"], 301_001)).toBeNull();
  expect(verifyCustomAppFileToken(token, ["B"], 1_001)).toBeNull();
});
