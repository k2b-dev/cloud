import { describe, expect, test } from "bun:test";
import { kiosk } from "../_internal/installable.test-fixture";
import { validateInstallable } from "./installable";

describe("standalone surface declaration", () => {
  test("requires a real own declared route covering the neutral start", () => {
    for (const routes of [["/app/inventory"], ["/app/inventory/"], ["/app/inventory/counter"]]) {
      expect(validateInstallable("inventory", routes, kiosk)).toEqual(kiosk);
    }
    for (const routes of [
      [],
      ["/"],
      ["/app"],
      ["/api/inventory"],
      ["/app/inventory/counter/documents"],
      ["//app/inventory"],
      ["/app/inventory//"],
    ]) {
      expect(validateInstallable("inventory", routes, kiosk)).toBeNull();
    }
  });

  test("rejects foreign, reserved and noncanonical paths before URL normalization", () => {
    for (const path of [
      "/",
      "/pwa/inventory/",
      "/public/inventory/counter/",
      "/app/contacts/counter/",
      "/app/inventory/",
      "/app/inventory/counter",
      "//app/inventory/counter/",
      "/app/inventory//counter/",
      "/app/inventory/counter//",
      "/app/inventory/./counter/",
      "/app/inventory/../counter/",
      "/app/inventory/%63ounter/",
      "/app/inventory/%2e%2e/counter/",
      "/app/inventory/counter/?x=1",
      "/app/inventory/counter/#top",
      "/app/inventory/counter\\/",
      "/app/inventory/_ssr/",
      "/app/inventory/help/",
      "/app/inventory/_internal/",
      " /app/inventory/counter/",
    ])
      expect(validateInstallable("inventory", ["/app/inventory"], { ...kiosk, path })).toBeNull();
  });

  test("one validated object, with Tabler icon, both hex themes and standalone display", () => {
    for (const value of [
      [kiosk, kiosk],
      null,
      { ...kiosk, display: "browser" },
      { ...kiosk, scope: "/" },
      { ...kiosk, name: " " },
      { ...kiosk, icon: "custom.svg" },
      { ...kiosk, themeColor: { light: "red", dark: "#090d12" } },
      { ...kiosk, themeColor: { light: "#fafafa" } },
    ])
      expect(validateInstallable("inventory", ["/app/inventory"], value)).toBeNull();
    expect(validateInstallable("inventory/foreign", ["/app/inventory"], kiosk)).toBeNull();
  });
});
