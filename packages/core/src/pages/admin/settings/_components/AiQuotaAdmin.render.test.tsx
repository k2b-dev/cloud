import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { AiQuotaConfig } from "@k2b/cloud/shared";
import { quotaFixture } from "./ai-quota-fixture";
const root = mkdtempSync(join(tmpdir(), "quota-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: Panel }] = await Promise.all([import("@k2b/ui"), import("./AiQuotaRules")]);
test("quota users and measured charts render with SSR data", async () => {
  const { default: Admin } = await import("./AiQuotaAdmin.island.tsx");
  const report = quotaFixture({
    overview: { cost: 1, accounts: 1, input: 20, output: 10, calls: 2, measured: 1, unknown: 1, estimated: 0 },
    timeline: [{ cost: 1, at: "2026-09-15T00:00:00Z", input: 20, output: 10, calls: 2, measured: 1, unknown: 1 }],
    models: [{ cost: 1, model: "a", input: 20, output: 10, calls: 2, measured: 1, unknown: 1 }],
  });
  const html = renderToString(() =>
    createComponent(Admin, {
      config: { enabled: false, revision: 0, rules: [] },
      models: [{ id: "a", label: "Model A", enabled: true, capabilities: ["streaming"] }],
      report,
    }),
  );
  expect(html).toContain("Current allowances");
  expect(html).toContain("Model A");
  expect(html).toContain("<svg");
  expect(html).toContain("Copy data");
  expect(html).not.toContain("NaN");
});
for (const locale of ["en", "de"])
  test(`quota rules render defaults and unlimited access in ${locale}`, () => {
    const render = (config: AiQuotaConfig) =>
      renderToString(() =>
        createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(Panel, { config, models: [{ id: "a", label: "Model A", enabled: true, capabilities: ["streaming"] }] });
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
  const html = renderToString(() =>
    createComponent(Panel, {
      models: [],
      config: {
        enabled: true,
        revision: 1,
        rules: [{ scope: "removed-profile", hours: 24, anchor: "2026-01-01T00:00:00Z", grants: [] }],
      },
    }),
  );
  expect(html).toContain("removed-profile");
});
test("principal picker placeholder follows both audience and service-account flags", async () => {
  const { PrincipalPicker: Picker } = await import("@k2b/cloud/access/ui");
  for (const [audience, service, expected] of [
    [false, false, "Add user or group"],
    [false, true, "Add user, group, or service account"],
    [true, false, "Add user, group, or audience"],
    [true, true, "Add user, group, service account, or audience"],
  ] as const) {
    const html = renderToString(() =>
      createComponent(Picker, { allowAuthenticated: audience, allowServiceAccounts: service, onSelect: () => {} }),
    );
    expect(html).toContain(expected);
  }
});

test("unpriced warning excludes audio, disabled and explicitly free models", () => {
  const model = { enabled: true, capabilities: ["streaming"] };
  const html = renderToString(() =>
    createComponent(Panel, {
      config: { enabled: false, revision: 0, rules: [] },
      models: [
        { ...model, id: "chat", label: "Unpriced chat" },
        { ...model, id: "audio", label: "Unpriced audio", capabilities: ["transcription"] },
        { ...model, id: "disabled", label: "Disabled model", enabled: false },
        { ...model, id: "free", label: "Free model", pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
      ],
    }),
  );
  expect(html).toContain("Unpriced chat");
  for (const excluded of ["Unpriced audio", "Disabled model", "Free model"]) expect(html).not.toContain(excluded);
});

test("audio-only and disabled unpriced profiles do not show an empty warning", () => {
  const html = renderToString(() =>
    createComponent(Panel, {
      config: { enabled: false, revision: 0, rules: [] },
      models: [
        { id: "audio", label: "Audio", enabled: true, capabilities: ["transcription"] },
        { id: "off", label: "Off", enabled: false, capabilities: ["streaming"] },
      ],
    }),
  );
  expect(html).not.toContain("Models without cost limits");
});
