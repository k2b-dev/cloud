import { expect, test } from "bun:test";
import { approvalAvailability, FREEIPA_APP_SIGN_IN_COOKIE, useAppSignIn } from "./availability";

test("activation, incomplete setup, configuration and read failures remain distinct", () => {
  expect(approvalAvailability(null)).toBe("unavailable");
  expect(approvalAvailability({ enabled: false, appOrigin: "" })).toBe("disabled");
  expect(approvalAvailability({ enabled: true, appOrigin: "" })).toBe("setup-required");
  expect(approvalAvailability({ enabled: true, appOrigin: "https://auth.example.test" })).toBe("configured");
});

const choose = (category: string, credential: string | null = null, cookieHeader: string | null = null, configured = true) =>
  useAppSignIn({ configured, category, credential, cookieHeader });
const usedApp = `${FREEIPA_APP_SIGN_IN_COOKIE}=1`;

test("Login starts with the app, FreeIPA with the password and Guest with email", () => {
  expect(choose("login")).toBe(true);
  expect(choose("freeipa")).toBe(false);
  expect(choose("guest")).toBe(false);
});

test("an explicit link opens the other credential for every account type", () => {
  for (const category of ["login", "freeipa", "guest"]) {
    expect(choose(category, "app")).toBe(true);
    expect(choose(category, "legacy")).toBe(false);
    expect(choose(category, "legacy", usedApp)).toBe(false);
  }
});

test("FreeIPA starts with the app in a browser that used it last", () => {
  expect(choose("freeipa", null, usedApp)).toBe(true);
  expect(choose("freeipa", null, `theme=dark; ${usedApp}; login_method=ipa`)).toBe(true);
  expect(choose("freeipa", null, `${FREEIPA_APP_SIGN_IN_COOKIE}=0`)).toBe(false);
  expect(choose("freeipa", null, `x${usedApp}`)).toBe(false);
});

test("the remembered FreeIPA choice does not change Login or Guest", () => {
  expect(choose("login", null, usedApp)).toBe(true);
  expect(choose("login", null, "login_method=ipa")).toBe(true);
  expect(choose("guest", null, usedApp)).toBe(false);
});

test("without configured app sign-in no account type offers the app", () => {
  for (const category of ["login", "freeipa", "guest"]) {
    expect(choose(category, null, usedApp, false)).toBe(false);
    expect(choose(category, "app", usedApp, false)).toBe(false);
  }
});
