import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { User } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-account-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: AccountHub }, { passwordSetupMessages }] = await Promise.all([
  import("@k2b/ui"),
  import("./AccountHub.tsx"),
  import("../auth/PasswordSetupFields.tsx"),
]);

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  uid: "ada",
  roles: ["local", "user", "group-manager"],
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

const renderAccountHub = (locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AccountHub, {
          user,
          active: "overview",
          loginLabel: "Firmenaccount",
          get children() {
            return "Content";
          },
        });
      },
    }),
  );

describe("AccountHub SSR locale", () => {
  test("keeps the shared password-field catalog complete", () => {
    expect(passwordSetupMessages.check()).toEqual([]);
    expect(passwordSetupMessages.resolve(["de-CH"]).t.confirmPassword).toBe("Neues Passwort bestätigen");
  });

  test("renders German navigation through the inherited request locale", () => {
    const html = renderAccountHub("de-CH");
    expect(html).toContain("Übersicht");
    expect(html).toContain("Sicherheit");
    expect(html).toContain("Gruppenverwaltung");
    expect(html).toContain("Firmenaccount");
    expect(html).toContain('aria-label="Kontobereiche"');
  });

  test("keeps English as the deterministic fallback", () => {
    const html = renderAccountHub("fr");
    expect(html).toContain("Overview");
    expect(html).toContain("Security");
  });
});
