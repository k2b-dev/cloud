import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { DEFAULT_LINUX_IDENTITY_CONFIGURATION } from "@valentinkolb/cloud/contracts";
import type { PosixCandidate } from "@valentinkolb/cloud/services";
import { linuxMessages } from "./linux-messages";

const root = mkdtempSync(join(tmpdir(), "core-linux-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: LinuxIdentityPanel } = await import("./LinuxIdentityPanel.island.tsx");
const local: PosixCandidate = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "alice",
  displayName: "Alice",
  provider: "local",
  profile: "user",
  state: "ready",
  identity: null,
};
const render = (enabled: boolean, items: PosixCandidate[], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(LinuxIdentityPanel, {
          initial: {
            config: { ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, enabled, rangeStart: 200000, rangeEnd: 299999 },
            items,
            nextCursor: null,
          },
        });
      },
    }),
  );

describe("Linux administration progressive disclosure", () => {
  test("disabled setup shows its entry point but no advanced configuration or bulk actions", () => {
    const html = render(false, [local]);
    expect(html).toContain("Set up local identities");
    expect(html).not.toContain("Home directory template");
    expect(html).not.toContain("Backfill 0 selected accounts");
    expect(html).not.toContain("<table");
    expect(html).toContain("k2b-notice-card");
    expect(html).not.toContain('data-tone="neutral"');
    expect(html).not.toContain("Local preparation is disabled.");
    expect(html).toContain("does not enable computer login or sudo");
  });
  test("enabled setup shows defaults without starting a backfill", () => {
    const html = render(true, [local]);
    expect(html).toContain("Home directory template");
    expect(html).toContain("Advanced: reserved UID/GID range");
    expect(html).toContain("Select account: alice");
    expect(html).toContain("/home/alice");
    expect(html).not.toContain('type="password"');
    expect(html).toContain('role="search"');
    expect(html).not.toContain("Apply filters");
    expect(html).not.toContain("Backfill 0 selected accounts");
  });
  test("displays incomplete IPA identity warnings when assignment is enabled", () => {
    const html = render(true, [
      {
        ...local,
        provider: "ipa",
        state: "ipa_pending",
        identity: {
          userId: local.id,
          managedBy: "ipa",
          uidNumber: 12345,
          primaryGidNumber: null,
          homeDirectory: "/srv/alice",
          loginShell: null,
        },
      },
    ]);
    expect(html).toContain("12345");
    expect(html).toContain("/srv/alice");
    expect(html).toContain("FreeIPA attributes incomplete");
    expect(html).toContain('aria-describedby="linux-status-');
    expect(html).toContain("disabled");
  });
  test("the inventory table uses an edge-to-edge data panel, not a padded settings body", () => {
    const html = render(true, [local]);
    const inventory = html.slice(html.indexOf("k2b-data-panel"));
    expect(inventory).toContain("Backfill existing accounts");
    expect(inventory).toContain("<table");
    expect(inventory).not.toContain("k2b-settings-section__body");
  });
  test("German regional locales use complete actionable copy", () => {
    expect(render(false, [local], "de-CH")).toContain("Lokale Identitäten einrichten");
    expect(linuxMessages.check()).toEqual([]);
  });
});
