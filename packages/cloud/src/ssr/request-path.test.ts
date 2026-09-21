import { expect, test } from "bun:test";
import { requestPath } from "./request-path";

test("requestPath drops the upstream origin and keeps the route", () => {
  expect(requestPath({ req: { raw: { url: "http://app-mail:3000/app/mail/Box001?view=needs_action&cursor=2" } } })).toBe(
    "/app/mail/Box001?view=needs_action&cursor=2",
  );
  expect(requestPath({ req: { raw: { url: "https://cloud.example.test/" } } })).toBe("/");
  expect(requestPath({ req: { raw: { url: "http://core:3000/admin?scroll=false" } } })).toBe("/admin?scroll=false");
});
