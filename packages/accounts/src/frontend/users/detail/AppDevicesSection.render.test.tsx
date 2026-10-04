import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PwaDeviceView } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "accounts-app-devices-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: AppDevicesSection }] = await Promise.all([import("@k2b/ui"), import("./AppDevicesSection")]);

/** Invented demo phones. */
const phones: PwaDeviceView[] = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Personal iPhone",
    platform: "ios",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastUsedAt: "2026-09-30T08:00:00.000Z",
    current: false,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Work phone",
    platform: "android",
    createdAt: "2026-09-12T10:00:00.000Z",
    lastUsedAt: "2026-10-01T08:00:00.000Z",
    current: false,
  },
];

const render = (devices: PwaDeviceView[], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AppDevicesSection, { userId: "11111111-1111-4111-8111-111111111111", devices, locale });
      },
    }),
  );

describe("App devices on the user detail page", () => {
  test("lists each phone with name, platform, pairing date, last use and a remove button", () => {
    const html = render(phones);
    expect(html).toContain("App devices");
    expect(html).toContain("2 phones are signed in to the mobile app");
    for (const header of ["Device", "Platform", "Paired since", "Last used"]) expect(html).toContain(header);
    expect(html).toContain("Personal iPhone");
    expect(html).toContain("iOS");
    expect(html).toContain("Android");
    expect(html).toContain("Sep 1, 2026");
    expect(html).toContain("Oct 1, 2026");
    expect(html).toContain('aria-label="Remove phone Work phone"');
  });

  test("speaks German", () => {
    const html = render(phones.slice(0, 1), "de");
    expect(html).toContain("App-Geräte");
    expect(html).toContain("1 Telefon ist in der Mobile App angemeldet");
    expect(html).toContain("Plattform");
    expect(html).toContain('aria-label="Telefon Personal iPhone entfernen"');
  });

  test("is absent while the person has no phones", () => {
    const html = render([]);
    expect(html).not.toContain("App devices");
    expect(html).not.toContain("<h2");
  });
});
