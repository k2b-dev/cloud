import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { OutgoingMailState } from "./OutgoingMail.island";

const root = mkdtempSync(join(tmpdir(), "cloud-outgoing-mail-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: OutgoingMail } = await import("./OutgoingMail.island.tsx");

const profile = (overrides: Partial<AdminMailProfile>): AdminMailProfile => ({
  key: "noreply",
  name: "No-reply",
  fromAddress: "noreply@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "smtp-user",
  hasPassword: true,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15 * 1024 * 1024,
  isDefault: true,
  revision: 1,
  createdAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  updatedBy: null,
  appCount: 2,
  ...overrides,
});

const state: OutgoingMailState = {
  profiles: [
    profile({}),
    profile({ key: "billing", name: "Billing", fromAddress: "billing@example.org", isDefault: false, dailyRecipientLimit: 500 }),
  ],
  apps: {
    defaultProfile: "noreply",
    items: [
      { appId: "core", name: "Core", registered: true, declared: true, mode: "default", profiles: [] },
      { appId: "invoices", name: "Invoices", registered: true, declared: true, mode: "selected", profiles: ["billing"] },
      { appId: "files", name: "Files", registered: true, declared: false, mode: "default", profiles: [] },
      { appId: "legacy", name: "legacy", registered: false, declared: false, mode: "selected", profiles: [] },
    ],
  },
};

const render = (locale: string, initial: OutgoingMailState) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(OutgoingMail, { initial });
      },
    }),
  );

test("shows profiles, the default, and each app's effective access in English and German", () => {
  const en = render("en", state);
  expect(en).toContain("Sender profiles");
  expect(en).toContain("noreply@example.org");
  expect(en).toContain("Default");
  expect(en).toContain("Sender name: app name");
  expect(en).toContain("500 recipients/day");
  expect(en).toContain("Default profile (No-reply)");
  expect(en).toContain(">Billing<");
  expect(en).toContain("No sending");
  expect(en).toContain("Does not request mail");
  expect(en).toContain("Not registered");
  expect(en).not.toContain("smtpPassword");

  const de = render("de", state);
  expect(de).toContain("Absenderprofile");
  expect(de).toContain("Standardprofil (No-reply)");
  expect(de).toContain("Kein Versand");
  expect(de).toContain("Fordert keine Mail an");
});

test("lists apps that request mail before the others", () => {
  const html = render("en", state);
  expect(html.indexOf("Invoices")).toBeLessThan(html.indexOf("Files"));
  expect(html.indexOf("Core")).toBeLessThan(html.indexOf("Files"));
});

test("an installation without profiles explains what to do first", () => {
  const html = render("en", { profiles: [], apps: { defaultProfile: null, items: state.apps.items } });
  expect(html).toContain("No sender profile yet");
  expect(html).toContain("Add profile");
  expect(html).toContain(">Default profile<");
});
