import { expect, spyOn, test } from "bun:test";
import { cookies } from "@k2b/stdlib/browser";
import { createDomTestHarness } from "./dom";

test("cookie deletion takes effect in the same millisecond, even if the cookie was absent", () => {
  const now = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 14, 12));
  const dom = createDomTestHarness();
  try {
    cookies.writeCookie("login_email", "1");
    cookies.writeCookie("login_method", "login");
    expect(cookies.readCookie("login_email")).toBe("1");
    cookies.deleteCookie("login_email");
    cookies.deleteCookie("absent");
    expect(dom.document.cookie).toBe("login_method=login");
    expect(cookies.readCookie("login_email")).toBeNull();
  } finally {
    dom.cleanup();
    now.mockRestore();
  }
});

test("a cookie expires at its deadline while future and session cookies remain", () => {
  const instant = Date.UTC(2026, 10, 14, 12);
  const now = spyOn(Date, "now").mockReturnValue(instant);
  const dom = createDomTestHarness();
  try {
    dom.document.cookie = `deadline=1; expires=${new Date(instant).toUTCString()}; path=/`;
    dom.document.cookie = "future=1; max-age=1; path=/";
    dom.document.cookie = "session=1; path=/";
    expect(dom.document.cookie).toBe("future=1; session=1");
    now.mockReturnValue(instant + 1_000);
    expect(dom.document.cookie).toBe("session=1");
  } finally {
    dom.cleanup();
    now.mockRestore();
  }
});
