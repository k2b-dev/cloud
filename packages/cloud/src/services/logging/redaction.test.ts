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
    "/%73hare/demo/x",
  ])("collapses all sensitive descendants in %s", (path) => {
    expect(redactSensitivePath(path)).toBe("/share/demo/:token");
  });

  test.each([
    ["/share/mail/attachments/token/download", "/share/mail/:token"],
    ["/api/mail/public-attachments/token/download", "/api/mail/public-attachments/:token"],
    ["//api//mail/public-attachments//token/", "/api/mail/public-attachments/:token"],
    ["/app/mail/a/token/download", "/app/mail/a/:token"],
    ["/api/mail/%70ublic-attachments/x/download", "/api/mail/public-attachments/:token"],
    ["/app/mail/%61/x", "/app/mail/a/:token"],
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
    "/api/mail/public-attachments-other/token",
  ])("preserves non-sensitive paths: %s", (path) => {
    expect(redactSensitivePath(path)).toBe(path);
  });

  const hex = "0123456789abcdef".repeat(3);
  const formToken = "AbCdEfGhIjKlMnOpQrStUv";
  const uuid = "20838fd2-8c26-42fa-a22d-904cfccda342";
  test.each([
    [`/api/venue/calendar/${hex}.ics`, "/api/venue/calendar/:token"],
    [`/api/spaces/calendar/ical/${hex}.ics`, "/api/spaces/calendar/ical/:token"],
    [`/api/grids/forms/public/${formToken}`, "/api/grids/forms/public/:token"],
    [`/api/grids/forms/public/${formToken}/submit`, "/api/grids/forms/public/:token/submit"],
    [`/api/grids/forms/public/${formToken}/relations/fld/lookup`, "/api/grids/forms/public/:token/relations/fld/lookup"],
    [`/tools/api/webhooks/receive/${hex}`, "/tools/api/webhooks/receive/:token"],
    [`/api/pulse/public-dashboard/${uuid}`, "/api/pulse/public-dashboard/:id"],
    [`/app/pulse/display/${uuid}`, "/app/pulse/display/:id"],
    [`/api/grids/apps/runtime/short/page/block/files/${formToken}.${hex}`, "/api/grids/apps/runtime/short/page/block/files/:token"],
    [`/api/demo/${Array.from(formToken, (letter) => `%${letter.charCodeAt(0).toString(16)}`).join("")}`, "/api/demo/:token"],
  ])("redacts bearer-shaped segments outside share routes: %s", (path, expected) => {
    expect(redactSensitivePath(path)).toBe(expected);
  });

  test.each([
    "getting-started",
    "getting-started-with-grids",
    "webservers",
    "tabler-icons.woff2",
    "fonts.css",
    "inbox",
    "app.locale",
    "some_setting_key_name",
    "4711",
    "%invalid",
  ])("preserves readable segments and malformed escapes: %s", (segment) => {
    expect(redactSensitivePath(`/api/demo/${segment}`)).toBe(`/api/demo/${segment}`);
  });

  test("drops queries and fragments even on normal paths", () => {
    expect(redactSensitivePath("/api/demo?secret=hidden#fragment")).toBe("/api/demo");
    expect(redactSensitivePath("/share/demo/token?secret=hidden")).toBe("/share/demo/:token");
  });
});
