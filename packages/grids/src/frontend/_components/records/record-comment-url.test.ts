import { expect, test } from "bun:test";
import { recordCommentsCursorUrl, recordCommentUrl } from "./record-comment-url";

test("comment mutation paths preserve the published page scope", () => {
  const endpoint = "/api/grids/apps/runtime/APP001/detail/comments/comments?cursor=REC001&limit=REC002";
  expect(recordCommentUrl(endpoint, "COMM01")).toBe(
    "/api/grids/apps/runtime/APP001/detail/comments/comments/COMM01?cursor=REC001&limit=REC002",
  );
  expect(recordCommentsCursorUrl(endpoint, "next+page/token", "_cursor")).toBe(`${endpoint}&_cursor=next%2Bpage%2Ftoken`);
});

test("Base comment URLs retain their existing cursor contract", () => {
  const endpoint = "/api/grids/records/TABLE1/REC001/comments";
  expect(recordCommentUrl(endpoint, "COMM01")).toBe(`${endpoint}/COMM01`);
  expect(recordCommentsCursorUrl(endpoint, "next+page/token", "cursor")).toBe(`${endpoint}?cursor=next%2Bpage%2Ftoken`);
});
