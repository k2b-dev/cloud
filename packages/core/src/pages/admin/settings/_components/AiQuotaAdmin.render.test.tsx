import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiQuotaConfig } from "@k2b/cloud/shared";
const root = mkdtempSync(join(tmpdir(), "quota-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: Panel }] = await Promise.all([import("@k2b/ui"), import("./AiQuotaAdmin.island.tsx")]);
for (const locale of ["en", "de"])
  test(`quota rules render defaults and unlimited access in ${locale}`, () => {
    const render = (config: AiQuotaConfig) =>
      renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(Panel, { config, models: [{ id: "a", label: "Model A" }] });
          },
        }),
      );
    const disabled = render({ enabled: false, revision: 0, rules: [] });
    expect(disabled).toContain(locale === "de" ? "Standardmäßig aus" : "Off by default");
    expect(disabled).not.toContain('checked=""');
    const enabled = render({
      enabled: true,
      revision: 1,
      rules: [
        { scope: "*", hours: 168, anchor: "1970-01-01T00:00:00.000Z", grants: [{ principal: { type: "authenticated" }, limit: null }] },
      ],
    });
    expect(enabled).toContain(locale === "de" ? "Unbegrenzt" : "Unlimited");
    expect(enabled).toContain(locale === "de" ? "Alle Chatmodelle" : "All chat models");
  });
test("removed model scope stays visible and editable", () => {
  const html = renderToString(() => createComponent(Panel, { models: [], config: {
    enabled: true, revision: 1, rules: [{ scope: "removed-profile", hours: 24, anchor: "2026-01-01T00:00:00Z", grants: [] }],
  } }));
  expect(html).toContain("removed-profile");
});
test("principal picker placeholder follows both audience and service-account flags", async () => {
  const { default: Picker } = await import("../../../../../../cloud/src/access/PrincipalPicker");
  for (const [audience, service, expected] of [[false, false, "Add user or group"], [false, true, "Add user, group, or service account"], [true, false, "Add user, group, or audience"], [true, true, "Add user, group, service account, or audience"]] as const) {
    const html = renderToString(() => createComponent(Picker, { allowAuthenticated: audience, allowServiceAccounts: service, onSelect: () => {} }));
    expect(html).toContain(expected);
  }
});
