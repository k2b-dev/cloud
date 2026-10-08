import { describe, expect, test } from "bun:test";
import { redactSensitivePath } from "./redaction";

describe("redactSensitivePath", () => {
  test.each([
    "/share/demo/abcdefghijklmnopqrstuvwxyzABCDEF",
    "/share/demo/short",
    "/share/demo/forms/token/download",
    "//share//demo///token/",
    "/share/demo/%61%62%63",
    "/share/demo/%2Ftoken%2Fdownload",
    "/share/demo/%invalid",
  ])("collapses all sensitive descendants in %s", (path) => {
    expect(redactSensitivePath(path)).toBe("/share/demo/:token");
  });

  test.each([
    ["/share/mail/attachments/token/download", "/share/mail/:token"],
    ["/api/mail/public-attachments/token/download", "/api/mail/public-attachments/:token"],
    ["//api//mail/public-attachments//token/", "/api/mail/public-attachments/:token"],
    ["/app/mail/a/token/download", "/app/mail/a/:token"],
  ])("keeps mail token paths protected: %s", (path, expected) => {
    expect(redactSensitivePath(path)).toBe(expected);
  });

  test.each([
    "/",
    "/api/demo/items",
    "/app/mail/inbox",
    "/share/demo",
    "/share/demo/",
    "/sharing/demo/token",
    "/Share/demo/token",
    "/%73hare/demo/token",
    "/api/mail/public-attachments-other/token",
  ])("preserves non-sensitive paths using the gateway's case-sensitive, encoded segment matching: %s", (path) => {
    expect(redactSensitivePath(path)).toBe(path);
  });

  test("drops queries and fragments even on normal paths", () => {
    expect(redactSensitivePath("/api/demo?secret=hidden#fragment")).toBe("/api/demo");
    expect(redactSensitivePath("/share/demo/token?secret=hidden")).toBe("/share/demo/:token");
  });
});
