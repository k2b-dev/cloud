import { describe, expect, test } from "bun:test";
import { resolveApplicationPackage } from "./application-package";
import builtInAppIds from "./built-in-app-ids.json";
import { inventory, publishedEntry } from "./define-app.test-fixture";
import { getProcessApplicationPackage } from "./process-identity";

describe("application package declaration", () => {
  test("defaults to the app ID and permits a distinct shared package", () => {
    expect(resolveApplicationPackage("orders")).toBe("orders");
    expect(resolveApplicationPackage("orders", "warenfluss")).toBe("warenfluss");
    expect(resolveApplicationPackage("stock", "warenfluss")).toBe("warenfluss");
  });
  test("binds and advertises the declared package through app.start", async () => {
    const entry = await publishedEntry({ ...inventory, package: "warenfluss" }, async () => {
      expect(getProcessApplicationPackage()).toBe("warenfluss");
    });
    expect(entry.package).toBe("warenfluss");
  });
  test.each(builtInAppIds)("reserves built-in ID %s even when the app is offline", (id) => {
    expect(() => resolveApplicationPackage("third-party", id)).toThrow("reserved");
    expect(resolveApplicationPackage(id)).toBe(id);
  });
  test("reserves storage as both app ID and package", () => {
    expect(() => resolveApplicationPackage("storage")).toThrow("reserved");
    expect(() => resolveApplicationPackage("orders", "storage")).toThrow("reserved");
  });
  test.each(["", "../mail", "a/b", "Mail", "a.b", "1app", "a%2fb", "a\\b", "café", "a\0b", "a".repeat(81)])(
    "rejects invalid name %j",
    (name) => {
      expect(() => resolveApplicationPackage("orders", name)).toThrow();
      expect(() => resolveApplicationPackage(name)).toThrow();
    },
  );
});
