import { expect, test } from "bun:test";
import { approvalAvailability, FREEIPA_APP_SIGN_IN_COOKIE, useAppSignIn } from "./availability";

test("activation, incomplete setup, configuration and read failures remain distinct", () => {
  expect(approvalAvailability(null)).toBe("unavailable");
  expect(approvalAvailability({ enabled: false, appOrigin: "" })).toBe("disabled");
  expect(approvalAvailability({ enabled: true, appOrigin: "" })).toBe("setup-required");
  expect(approvalAvailability({ enabled: true, appOrigin: "https://auth.example.test" })).toBe("configured");
});

const choose = (category: string, query = "", cookieHeader: string | null = null, configured = true) =>
  useAppSignIn({ configured, category, query: new URLSearchParams(query), cookieHeader });
const usedApp = `${FREEIPA_APP_SIGN_IN_COOKIE}=1`;

test("Login starts with the app, FreeIPA with the password and Guest with email", () => {
  expect(choose("login")).toBe(true);
  expect(choose("freeipa")).toBe(false);
  expect(choose("guest")).toBe(false);
});

test("an explicit link opens the other credential for every account type", () => {
  for (const category of ["login", "freeipa", "guest"]) {
    expect(choose(category, "credential=app")).toBe(true);
    expect(choose(category, "credential=legacy")).toBe(false);
    expect(choose(category, "credential=legacy", usedApp)).toBe(false);
  }
});

test("FreeIPA starts with the app in a browser that used it last", () => {
  expect(choose("freeipa", "", usedApp)).toBe(true);
  expect(choose("freeipa", "", `theme=dark; ${usedApp}; login_method=ipa`)).toBe(true);
  expect(choose("freeipa", "", `${FREEIPA_APP_SIGN_IN_COOKIE}=0`)).toBe(false);
  expect(choose("freeipa", "", `x${usedApp}`)).toBe(false);
});

test("the remembered FreeIPA choice does not change Login or Guest", () => {
  expect(choose("login", "", usedApp)).toBe(true);
  expect(choose("login", "", "login_method=ipa")).toBe(true);
  expect(choose("guest", "", usedApp)).toBe(false);
});

test("without configured app sign-in no account type offers the app", () => {
  for (const category of ["login", "freeipa", "guest"]) {
    expect(choose(category, "", usedApp, false)).toBe(false);
    expect(choose(category, "credential=app", usedApp, false)).toBe(false);
  }
});

test("the identifier a link carries never changes the offered credential", () => {
  // `ipa-uid` is the only identifier the sign-in page receives. A local account's
  // name, a FreeIPA name and an unknown name must all open the same form.
  const identifiers = ["", "ipa-uid=mira.local", "ipa-uid=jonas.directory", "ipa-uid=nobody", "ipa-uid=mira%40example.test"];
  for (const category of ["login", "freeipa", "guest"]) {
    for (const cookie of [null, usedApp]) {
      for (const base of ["", "credential=app", "credential=legacy", "method=ipa&hide=guest&banner=true"]) {
        const results = identifiers.map((identifier) => choose(category, [base, identifier].filter(Boolean).join("&"), cookie));
        expect(new Set(results).size).toBe(1);
      }
    }
  }
});
