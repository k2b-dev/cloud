import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cloud from "@k2b/cloud";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "@k2b/cloud/contracts";
import * as services from "@k2b/cloud/services";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { FREEIPA_APP_SIGN_IN_COOKIE } from "../app-approval/availability";

const root = mkdtempSync(join(tmpdir(), "core-login-page-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => rmSync(root, { recursive: true, force: true }));
const { default: handler } = await import("./page");

const spies: Array<{ mockRestore(): void }> = [];
let appSignInConfigured = true;
beforeEach(() => {
  appSignInConfigured = true;
  spies.push(
    spyOn(services.coreSettings, "get").mockImplementation(async (key) => (key === "freeipa.enable" ? true : undefined) as never),
    spyOn(services, "readAccountCategoryPolicy").mockResolvedValue(DEFAULT_ACCOUNT_CATEGORY_POLICY),
    spyOn(cloud, "listLegalLinks").mockResolvedValue([]),
    spyOn(services.appApproval, "config").mockImplementation(async () => {
      if (!appSignInConfigured) throw new services.AppApprovalError("UNAVAILABLE", 503);
      return { issuer: "https://cloud.example.test", appOrigin: "https://auth.example.test", enabled: true, adminPairing: false };
    }),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

const usedApp = `login_method=ipa; ${FREEIPA_APP_SIGN_IN_COOKIE}=1`;
/** The server-rendered sign-in page, as a browser without JavaScript receives it. */
const page = async (query = "", cookie = "") => {
  const app = new Hono().get("/auth/login", ...handler);
  const response = await app.request(`https://cloud.example.test/auth/login${query}`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  const html = (await response.text()).replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  return {
    html,
    form: /data-file="(\w*LoginForm)\.island\.tsx"/.exec(html)?.[1],
    category: /category:"(\w+)"/.exec(html)?.[1],
    /** The plain link to the other credential: [target, label]. */
    alternative: /<a href="([^"]+)" class="k2b-button auth-login-alternative[^>]*><span[^>]*>([^<]+)</.exec(html)?.slice(1),
  };
};

test("FreeIPA opens with the password and the name from the link, one link away from the app", async () => {
  const password = await page("?method=ipa&ipa-uid=mira&redirectTo=%2Fapp%2Ffiles");
  expect(password.form).toBe("LoginForm");
  expect(password.html).toContain('value="mira"');
  expect(password.html).toContain("Sign in with your FreeIPA password.");
  expect(password.alternative).toEqual([
    "/auth/login?method=ipa&ipa-uid=mira&redirectTo=%2Fapp%2Ffiles&credential=app",
    "Use the app instead",
  ]);

  const app = await page(new URL(password.alternative![0]!, "https://cloud.example.test").search);
  expect([app.form, app.category]).toEqual(["AppLoginForm", "freeipa"]);
  expect(app.html).toContain("No paired app? Use your password.");
  expect(app.alternative).toEqual([
    "/auth/login?method=ipa&ipa-uid=mira&redirectTo=%2Fapp%2Ffiles&credential=legacy",
    "Use your FreeIPA password instead",
  ]);
  // The way back opens the password form again, also in a browser that remembers the app.
  const back = new URL(app.alternative![0]!, "https://cloud.example.test").search;
  expect((await page(back)).form).toBe("LoginForm");
  expect((await page(back, usedApp)).form).toBe("LoginForm");
});

test("a browser that last signed in to FreeIPA with the app opens FreeIPA with the app", async () => {
  expect((await page("", "login_method=ipa")).form).toBe("LoginForm");
  const remembered = await page("", usedApp);
  expect([remembered.form, remembered.category]).toEqual(["AppLoginForm", "freeipa"]);
  expect(remembered.alternative).toEqual(["/auth/login?credential=legacy", "Use your FreeIPA password instead"]);
  // The memory belongs to FreeIPA: Login and Guest keep their own defaults.
  for (const cookie of ["", usedApp]) {
    const login = await page("?method=login", cookie);
    expect([login.form, login.category]).toEqual(["AppLoginForm", "login"]);
    expect(login.alternative).toEqual(["/auth/login?method=login&credential=legacy", "Use an email link instead"]);
    const guest = await page("?method=guest", cookie);
    expect(guest.form).toBe("GuestLoginForm");
    expect(guest.alternative).toEqual(["/auth/login?method=guest&credential=app", "Use the app instead"]);
  }
});

test("the name a link carries never changes which form opens", async () => {
  // `ipa-uid` is the only identifier the page receives. No name, a FreeIPA name,
  // a local account's address and an unknown name must all open the same form.
  const names = ["", "ipa-uid=jonas", "ipa-uid=mira%40example.test", "ipa-uid=nobody"];
  for (const cookie of ["", usedApp]) {
    for (const base of ["method=ipa", "method=login", "method=guest", "method=ipa&credential=app"]) {
      const opened = new Set<string>();
      for (const name of names) {
        const { form, category, alternative } = await page(`?${[base, name].filter(Boolean).join("&")}`, cookie);
        opened.add(JSON.stringify([form, category, alternative?.[1]]));
      }
      expect(opened.size).toBe(1);
    }
  }
});

test("without configured app sign-in the page offers no app form or link", async () => {
  appSignInConfigured = false;
  for (const query of ["?method=ipa", "?method=ipa&credential=app", "?method=login&credential=app"]) {
    const { form, alternative } = await page(query, usedApp);
    expect(form).toBe(query.includes("ipa") ? "LoginForm" : "GuestLoginForm");
    expect(alternative).toBeUndefined();
  }
});

test("both directions are labelled in German", async () => {
  expect((await page("?method=ipa", "cloud.locale=de")).alternative?.[1]).toBe("Stattdessen die App nutzen");
  expect((await page("?method=ipa&credential=app", "cloud.locale=de")).alternative?.[1]).toBe("Stattdessen FreeIPA-Passwort nutzen");
});
