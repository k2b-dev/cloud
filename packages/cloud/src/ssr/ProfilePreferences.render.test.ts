import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import type { User } from "../contracts/shared";

const root = mkdtempSync(resolve(tmpdir(), "cloud-profile-preferences-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { default: Layout } = await import("./Layout");

const user: User = {
  accountExpires: null,
  avatarHash: null,
  displayName: "Ada Lovelace",
  givenname: "Ada",
  id: "ada",
  ipa: null,
  lastLoginLocal: null,
  mail: "ada@example.test",
  manages: [],
  managesGroupIds: [],
  memberofGroup: [],
  memberofGroupIds: [],
  profile: "user",
  provider: "local",
  roles: ["user"],
  sn: "Lovelace",
  uid: "ada",
};

const app = defineApp({
  id: "profile-preferences-probe",
  name: "Profile preferences probe",
  icon: "ti ti-user",
  description: "SSR profile preferences probe",
  baseUrl: "http://profile-preferences-probe:3000",
  routes: ["/app/profile-preferences-probe"],
});

type LayoutContextArg = Parameters<typeof Layout>[0]["c"];

const server = new Hono()
  .use("*", async (c, next) => {
    c.set("runtime" as never, { apps: [] } as never);
    await next();
  })
  .get(
    "/",
    ...app.ssr((c) => {
      c.set("user" as never, user as never);
      return () =>
        createComponent(Layout, {
          c: c as unknown as LayoutContextArg,
          title: "Preferences",
          children: "Profile preferences content",
        });
    }),
  );

describe("ProfilePreferences SSR", () => {
  test("renders the avatar once, in the rail, without browser globals", async () => {
    const response = await server.request("/", {
      headers: { Cookie: "theme=dark", "Accept-Language": "de-CH" },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-layout-authenticated="true"');
    // The header has no avatar: from md the rail holds it, and phones reach the profile through the app menu.
    expect(html.split('class="layout-profile-preferences"').length - 1).toBe(1);
    expect(html).toContain('href="/me"');
    const panel = html
      .split('class="layout-profile-preferences__panel dropdown-menu-surface"')[1]!
      .split('class="layout-profile-preferences__dropdown"')[0]!;
    expect(panel).toContain('aria-label="Darstellung: Dunkel. Wechselt zu Automatisch."');
    expect(panel).toContain('class="ti ti-moon"');
    expect(panel).toContain(">Dunkel</span>");
    expect(panel).not.toContain('role="radiogroup"');
    expect(panel).not.toContain("k2b-segmented-control");
    expect(html).toContain("English");
    expect(html).toContain("Profileinstellungen");
    expect(html).toContain("Abmelden");
    expect(html).toContain('<button type="button" class="layout-profile-preferences__link"');
    expect(html).not.toContain('<a href="/me" class="layout-profile-preferences__link"');
    expect(html.indexOf("Abmelden")).toBeGreaterThan(html.indexOf("Profileinstellungen"));
    expect(html).toContain('data-position="right-start"');
    expect(html).not.toContain(user.mail ?? "");
    expect(html).not.toContain("undefined");
  });
  test("defaults to Automatic without a saved choice", async () => {
    const html = await (await server.request("/", { headers: { "Accept-Language": "de" } })).text();
    expect(html).toContain('aria-label="Darstellung: Automatisch. Wechselt zu Hell."');
    expect(html).toContain('class="ti ti-device-laptop"');
    expect(html).toContain(">Automatisch</span>");
  });
});

let railSnapshot: ReturnType<typeof stubRailSnapshot>;
beforeEach(() => {
  railSnapshot = stubRailSnapshot();
});
afterEach(() => railSnapshot.mockRestore());
