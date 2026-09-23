import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { MAIL_CONTACT_DIRECTORY_DEFAULTS } from "../../contact-directory-settings";
import type { ContactDirectoryAdminView } from "../../service/contact-directory";

const root = mkdtempSync(join(tmpdir(), "mail-contact-directory-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailAdminContactDirectory } = await import("./MailAdminContactDirectory.island.tsx");

const render = (view: ContactDirectoryAdminView, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailAdminContactDirectory, { view });
      },
    }),
  );

describe("Mail admin contact directory summary", () => {
  test("names the app and whether it uses the Contacts defaults", () => {
    const html = render({
      config: { ...MAIL_CONTACT_DIRECTORY_DEFAULTS },
      apps: [
        {
          appId: "contacts",
          appName: "Contacts",
          appIcon: "",
          capabilities: { suggest: [], resolve: [], read: [], listWritableBooks: [], create: [] },
        },
      ],
      issues: [],
    });
    expect(html).toContain("Contact directory");
    expect(html).toContain(">Contacts · Defaults<");
    expect(html).toContain("Configure");
    expect(html).not.toContain("Needs attention");
  });

  test("falls back to the app id and flags a stored mapping Mail cannot use", () => {
    const html = render(
      {
        config: { appId: "crm", suggest: "customer.suggest", resolve: "", read: "", listWritableBooks: "", create: "" },
        apps: null,
        issues: [{ field: "resolve", code: "required", message: "Choose a capability." }],
      },
      "de",
    );
    expect(html).toContain("Kontaktverzeichnis");
    expect(html).toContain("crm");
    expect(html).toContain("Angepasst");
    expect(html).toContain("Handlungsbedarf");
    expect(html).toContain("Konfigurieren");
  });
});
