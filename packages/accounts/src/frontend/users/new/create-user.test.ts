import { describe, expect, test } from "bun:test";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import { allowedCategories, type CreateUserForm, createUserPayload, emailOptional, missingFields } from "./create-user";

const form = (patch: Partial<CreateUserForm> = {}): CreateUserForm => ({
  category: "login",
  givenname: " Ada ",
  sn: "Lovelace",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  admin: false,
  welcome: true,
  ...patch,
});

describe("a new account's rules", () => {
  test("the types on offer follow the policy, FreeIPA only while it is on, and a request only in FreeIPA", () => {
    expect(allowedCategories(DEFAULT_ACCOUNT_CATEGORY_POLICY, true, false)).toEqual(["freeipa", "login", "guest"]);
    expect(allowedCategories(DEFAULT_ACCOUNT_CATEGORY_POLICY, false, false)).toEqual(["login", "guest"]);
    expect(allowedCategories(DEFAULT_ACCOUNT_CATEGORY_POLICY, true, true)).toEqual(["freeipa"]);
    expect(allowedCategories(DEFAULT_ACCOUNT_CATEGORY_POLICY, false, true)).toEqual([]);
    expect(allowedCategories({ ...DEFAULT_ACCOUNT_CATEGORY_POLICY, guest: { enabled: false, visible: true } }, false, false)).toEqual([
      "login",
    ]);
  });

  test("only a Login account may lack an email, while the installation allows it; guests and requests never", () => {
    expect(emailOptional({ category: "login" }, true, false)).toBe(true);
    expect(emailOptional({ category: "login" }, false, false)).toBe(false);
    expect(emailOptional({ category: "guest" }, true, false)).toBe(false);
    expect(emailOptional({ category: "freeipa" }, true, false)).toBe(false);
    expect(emailOptional({ category: "login" }, true, true)).toBe(false);
  });

  test("what is missing before sending", () => {
    expect(missingFields(form({ category: undefined, givenname: " ", email: "" }), false)).toEqual({
      category: true,
      email: true,
      givenname: true,
      sn: false,
    });
    expect(missingFields(form({ email: "" }), true).email).toBe(false);
  });

  test("a Login account keeps administration, a guest never has it, and the names are trimmed", () => {
    expect(createUserPayload({ ...form({ admin: true }), category: "login" })).toEqual({
      provider: "local",
      profile: "user",
      admin: true,
      email: "ada@example.com",
      givenname: "Ada",
      sn: "Lovelace",
      displayName: "Ada Lovelace",
      autoSendNotification: true,
      requestId: undefined,
    });
    expect(createUserPayload({ ...form({ admin: true }), category: "guest" })).toMatchObject({ profile: "guest", admin: false });
  });

  test("without an email no welcome mail goes out", () => {
    const payload = createUserPayload({ ...form({ email: " " }), category: "login" });
    expect(payload).toMatchObject({ provider: "local", autoSendNotification: false });
    expect("email" in payload && payload.email).toBeUndefined();
  });

  test("a FreeIPA account has no profile and carries its request", () => {
    const payload = createUserPayload({ ...form({ welcome: false }), category: "freeipa" }, "request-1");
    expect(payload).toEqual({
      provider: "ipa",
      email: "ada@example.com",
      givenname: "Ada",
      sn: "Lovelace",
      displayName: "Ada Lovelace",
      autoSendNotification: false,
      requestId: "request-1",
    });
  });
});
