import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-account-app-tab-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: AccountHub }, { pwaAvailable }] = await Promise.all([
  import("@k2b/ui"),
  import("./AccountHub.tsx"),
  import("./app-availability.ts"),
]);

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  uid: "ada",
  roles: ["local", "user"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Lovelace",
  displayName: "Ada Lovelace",
  mail: "ada@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const render = (appTab: boolean, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AccountHub, {
          user,
          active: appTab ? "app" : "profile",
          loginLabel: "Account",
          appTab,
          get children() {
            return "Content";
          },
        });
      },
    }),
  );

describe("account App tab", () => {
  test("appears only while the mobile app runs", () => {
    const shown = render(true);
    expect(shown).toContain('href="/me/app"');
    expect(shown).toMatch(/href="\/me\/app"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/me\/app"/);
    expect(render(true, "de")).toContain(">App<");
    expect(render(false)).not.toContain("/me/app");
  });

  test("availability follows the registered shell", () => {
    const context = (apps: { id: string; routes: string[] }[]) => ({ get: () => ({ apps }) });
    expect(pwaAvailable(context([]))).toBeFalse();
    expect(pwaAvailable(context([{ id: "pwa", routes: ["/pwa", "/public/pwa"] }]))).toBeTrue();
  });
});
