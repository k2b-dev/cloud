import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { bundledStatus, emptyStatus, maxmindStatus, staleStatus, uploadedStatus } from "./sign-in-locations-fixture";

const root = mkdtempSync(join(tmpdir(), "cloud-sign-in-locations-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SignInLocations } = await import("./SignInLocations.tsx");
const { default: Form } = await import("./CoreSettingsForm.island.tsx");

const html = (initial: GeoIpAdminStatus | null, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(SignInLocations, { initial });
      },
    }),
  );
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("sign-in locations block", () => {
  test("shows source, database type and build date per type with the DB-IP attribution link", () => {
    const markup = html(bundledStatus);
    expect(text(markup)).toContain("Places Bundled DB-IP Lite snapshot · DBIP-City-Lite As of Oct 1, 2026");
    expect(text(markup)).toContain("Network operators Bundled DB-IP Lite snapshot · DBIP-ASN-Lite (compat=GeoLite2-ASN) As of Oct 1, 2026");
    expect(markup).toContain('href="https://db-ip.com"');
    expect(text(markup)).toContain("IP Geolocation by DB-IP");
    expect(markup).not.toContain("data-geoip-stale");
  });

  test("names the uploaded file and drops the attribution once no DB-IP data is active", () => {
    expect(text(html(uploadedStatus))).toContain("Places Uploaded file · GeoLite2-City As of Oct 14, 2026");
    // The ASN type still uses the bundled DB-IP data, so the attribution stays.
    expect(html(uploadedStatus)).toContain('href="https://db-ip.com"');
    const maxmind = html(maxmindStatus, "de");
    expect(text(maxmind)).toContain("Netzbetreiber Hochgeladene Datei · GeoLite2-ASN Stand 14.10.2026");
    expect(maxmind).not.toContain("db-ip.com");
  });

  test("a stale snapshot carries a calm hint in its row and in the status line", () => {
    const markup = html(staleStatus);
    expect(markup.match(/data-geoip-stale/g)).toHaveLength(2);
    expect(text(markup)).toContain("As of Mar 1, 2026 · older than 6 months");
    expect(text(markup)).toContain("Some data is older than 6 months. Update Cloud or upload a newer file.");
    expect(text(html(staleStatus, "de"))).toContain("Stand 01.03.2026 · älter als 6 Monate");
  });

  test("without a snapshot each type says how to get data and reset stays disabled", () => {
    const markup = html(emptyStatus, "de");
    expect(text(markup)).toContain("Orte Keine Daten Lade eine City-Datenbank hoch, um Orte zu zeigen.");
    expect(text(markup)).toContain("Netzbetreiber Keine Daten Lade eine ASN-Datenbank hoch, um Netzbetreiber zu zeigen.");
    expect(markup).not.toContain("db-ip.com");
    expect(markup.match(/<button[^>]*disabled[^>]*>/g)?.length).toBe(2);
  });

  test("the sign-in settings tab renders the block with the server status", () => {
    const markup = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(Form, {
            title: "Sign-in",
            subtitle: "",
            icon: "ti ti-users",
            entries: [],
            accountSection: "sign-in",
            signInLocations: { status: bundledStatus },
          });
        },
      }),
    );
    expect(text(markup)).toContain("Sign-in locations");
    expect(markup).toContain('data-geoip-kind="city"');
  });
});
