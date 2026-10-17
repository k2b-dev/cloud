import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { StoreConfig } from "../../store/contracts";
import { storeMessages } from "./messages";

const root = mkdtempSync(join(tmpdir(), "pulse-store-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: StoreAdmin } = await import("./StoreAdmin.island");
const render = (initial: StoreConfig, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(StoreAdmin, { initial });
      },
    }),
  );
test("without a connection the first frame shows the three operator steps and the connection form", () => {
  const html = render({ configured: false, url: "", user: "pulse_service", passwordSet: false });
  expect(html).toContain("Not set up yet");
  expect(html).toContain("Start ClickHouse 26.9 or newer");
  expect(html).toContain("Run the setup script once as the ClickHouse admin");
  expect(html).toContain("Enter the address and the service user here");
  expect(html).toContain("Setup script");
  expect(html).toContain("Check and connect");
  expect(html).toContain('type="password"');
  expect(html).toContain("pulse_service");
});
test("with a connection the first frame shows the saved address and a pending status, never a password", () => {
  const html = render({ configured: true, url: "http://fixture.invalid:8123", user: "pulse_service", passwordSet: true }, "de");
  expect(html).toContain("Verbindung wird geprüft");
  expect(html).toContain("http://fixture.invalid:8123");
  expect(html).toContain("Verschlüsselt gespeichert");
  expect(html).toContain("Ändern");
  expect(html).not.toContain("Noch nicht eingerichtet");
  expect(html).not.toContain('type="password"');
});
test("admin catalog is complete in German", () => expect(storeMessages.check()).toEqual([]));
