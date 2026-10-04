import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { stubRailSnapshot } from "../../../../tests/fixtures/rail-snapshot";
import type { RuntimeAppMeta } from "../contracts/app";
import type { User } from "../contracts/shared";

const root = mkdtempSync(resolve(tmpdir(), "cloud-profile-app-item-tests-"));
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
const shell = {
  id: "pwa",
  name: "Mobile app",
  icon: "ti ti-device-mobile",
  description: "",
  routes: ["/pwa", "/public/pwa"],
} as RuntimeAppMeta;

const app = defineApp({
  id: "profile-app-item-probe",
  name: "Profile app item probe",
  icon: "ti ti-user",
  description: "SSR profile menu probe",
  baseUrl: "http://profile-app-item-probe:3000",
  routes: ["/app/profile-app-item-probe"],
});
type LayoutContextArg = Parameters<typeof Layout>[0]["c"];

const page = (apps: RuntimeAppMeta[]) =>
  new Hono()
    .use("*", async (c, next) => {
      c.set("runtime" as never, { apps } as never);
      await next();
    })
    .get(
      "/",
      ...app.ssr((c) => {
        c.set("user" as never, user as never);
        return () => createComponent(Layout, { c: c as unknown as LayoutContextArg, title: "Probe", children: "Content" });
      }),
    );

describe("profile menu App item", () => {
  test("appears in the header and rail menus and the mobile launcher data while the mobile app runs", async () => {
    const html = await (await page([shell]).request("/", { headers: { "Accept-Language": "de" } })).text();
    // The no-JS panels of both placements link it.
    expect(html.match(/<a href="\/me\/app" class="menu-item">/g)).toHaveLength(2);
    expect(html).toContain("ti ti-device-mobile");
    // The mobile launcher reads the profile from embedded data.
    const data = html.match(/<script id="cloud-app-launchpad-data" type="application\/json">(.*?)<\/script>/)?.[1] ?? "";
    expect(JSON.parse(data).profile).toMatchObject({ appHref: "/me/app" });
  });

  test("is absent without the mobile app", async () => {
    const html = await (await page([]).request("/")).text();
    expect(html).not.toContain("/me/app");
  });
});

let railSnapshot: ReturnType<typeof stubRailSnapshot>;
beforeEach(() => {
  railSnapshot = stubRailSnapshot();
});
afterEach(() => railSnapshot.mockRestore());
