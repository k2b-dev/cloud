import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { CORE_SETTINGS } from "@valentinkolb/cloud/services/settings/core-settings";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { authMessages } from "../../../auth/messages";
import type { SettingFieldDef } from "./CoreSettingsForm.island";
import { settingsMessages } from "./messages";

const root = mkdtempSync(join(tmpdir(), "cloud-categories-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Form } = await import("./CoreSettingsForm.island.tsx");
const { default: AccountCategorySwitch } = await import("../../../auth/AccountCategorySwitch.island.tsx");

test("login categories use the shared segmented radio control", () => {
  const html = renderToString(() =>
    createComponent(AccountCategorySwitch, {
      options: [
        { value: "guest", label: "Guest", href: "/auth/login?method=guest" },
        { value: "login", label: "Firmenaccount", href: "/auth/login?method=login" },
        { value: "freeipa", label: "FreeIPA", href: "/auth/login?method=ipa" },
      ],
      value: "login",
      ariaLabel: "Account type",
    }),
  );
  expect(html).toContain("k2b-segmented-control");
  expect(html).toContain('role="radiogroup"');
  expect(html.match(/role="radio"/g)).toHaveLength(3);
  expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  expect(html).toContain("Firmenaccount");
});
const render = (enabled: boolean, locale = "en") => {
  const entries: SettingFieldDef[] = Object.entries(CORE_SETTINGS)
    .filter(([key]) => key.startsWith("user.category.") || key.startsWith("user.app_approval.") || key === "user.allow_self_registration")
    .map(([key, def]) => ({
      key,
      label: def.label,
      description: def.description,
      kind: def.kind,
      default: def.default,
      resetValue: def.default,
      value: key.endsWith(".enabled") ? enabled : def.default,
      isCustom: false,
      valueSource: "default",
      resetValueSource: "default",
      group: "user",
    }));
  return renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(Form, { title: "Accounts", subtitle: "", icon: "ti ti-users", entries });
      },
    }),
  );
};

describe("account category administration", () => {
  test("app approval reveals integration settings only when enabled", () => {
    expect(render(false)).toContain("Allow app approval");
    expect(render(false)).not.toContain("Authenticator website origin");
    expect(render(true)).toContain("Authenticator website origin");
    expect(render(true, "de")).toContain("API für App-Freigaben");
  });
  test("enabled categories reveal their visibility and name controls", () => {
    const html = render(true);
    expect(html).toContain("Show Guest in login");
    expect(html).toContain("Login account label");
    expect(html).toContain("Show FreeIPA in login");
    expect(html).toContain("existing sessions");
  });
  test("disabled categories retain allow controls but hide irrelevant details", () => {
    const html = render(false);
    expect(html).toContain("Guest accounts allowed");
    expect(html).not.toContain("Show Guest in login");
    expect(html).not.toContain("Login account label");
    expect(html).not.toContain('name="user.allow_self_registration"');
  });
  test("German labels and both catalogs are complete", () => {
    expect(render(true, "de-CH")).toContain("Guest-Accounts erlauben");
    expect(render(true, "de-CH")).toContain("Anzeigename");
    expect(settingsMessages.check()).toEqual([]);
    expect(authMessages.check()).toEqual([]);
  });
});
