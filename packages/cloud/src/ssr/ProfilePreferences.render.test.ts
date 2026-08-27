import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
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
  test("renders both responsive placements without browser globals", async () => {
    const response = await server.request("/", {
      headers: { Cookie: "theme=dark", "Accept-Language": "de-CH" },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-layout-authenticated="true"');
    expect(html).toContain('data-placement="header"');
    expect(html).toContain('data-placement="rail"');
    expect(html).toContain('href="/me"');
    expect(html).toContain("Heller Modus");
    expect(html).toContain("English");
    expect(html).toContain("Profileinstellungen");
    expect(html).toContain('data-position="bottom-left"');
    expect(html).toContain('data-position="right-start"');
    expect(html).not.toContain(user.mail ?? "");
    expect(html).not.toContain("undefined");
  });
});
