import { describe, expect, test } from "bun:test";
import {
  accountCategory,
  accountCategoryLabel,
  DEFAULT_ACCOUNT_CATEGORY_POLICY,
  resolveAccountCategoryLogin,
  visibleAccountCategories,
} from "./account-categories";

describe("account categories", () => {
  test("derives three categories without changing provider/profile", () => {
    expect(accountCategory({ provider: "local", profile: "guest" })).toBe("guest");
    expect(accountCategory({ provider: "local", profile: "user" })).toBe("login");
    for (const profile of ["user", "guest"] as const) expect(accountCategory({ provider: "ipa", profile })).toBe("freeipa");
    expect(accountCategoryLabel({ provider: "local", profile: "user" }, " Firmenaccount ")).toBe("Firmenaccount");
    expect(accountCategoryLabel({ provider: "local", profile: "user" }, " ")).toBe("Login");
    expect(accountCategoryLabel({ provider: "ipa", profile: "guest" }, "Company")).toBe("FreeIPA");
  });

  test("defaults offer all supported categories and honor the existing IPA switch", () => {
    expect(visibleAccountCategories(DEFAULT_ACCOUNT_CATEGORY_POLICY, true)).toEqual(["guest", "login", "freeipa"]);
    expect(visibleAccountCategories(DEFAULT_ACCOUNT_CATEGORY_POLICY, false)).toEqual(["guest", "login"]);
  });

  test("company-only configuration has one direct entry", () => {
    const policy = structuredClone(DEFAULT_ACCOUNT_CATEGORY_POLICY);
    policy.guest.enabled = policy.freeipa.enabled = false;
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: true })).toEqual({ visible: ["login"], active: "login" });
  });

  test("hidden allowed categories work only by explicit link, not remembered choice", () => {
    const policy = structuredClone(DEFAULT_ACCOUNT_CATEGORY_POLICY);
    policy.guest.visible = false;
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: false, remembered: "guest" }).active).toBe("login");
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: false, method: "guest" }).active).toBe("guest");
    policy.guest.enabled = false;
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: false, method: "guest" }).active).toBeNull();
  });

  test("no visible category does not silently offer a hidden option", () => {
    const policy = structuredClone(DEFAULT_ACCOUNT_CATEGORY_POLICY);
    policy.guest.visible = policy.login.visible = policy.freeipa.visible = false;
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: true })).toEqual({ visible: [], active: null });
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: true, method: "ipa" }).active).toBe("freeipa");
  });

  test("legacy email links and in-flight token verification stay category-unbound", () => {
    const policy = structuredClone(DEFAULT_ACCOUNT_CATEGORY_POLICY);
    policy.guest.enabled = false;
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: true, method: "email" }).active).toBe("email");
    policy.login.enabled = false;
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: true, method: "email" }).active).toBeNull();
    expect(resolveAccountCategoryLogin({ policy, freeIpaEnabled: true, hasToken: true }).active).toBe("email");
  });
});
