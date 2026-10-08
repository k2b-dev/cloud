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
  imap: null,
  bounces: null,
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
  log: {
    filter: {},
    retention: { contentDays: 90, recordDays: 365 },
    page: {
      items: [
        {
          id: "0b1f4d43-34c9-4f0e-9a39-6c4c7b2c5f10",
          appId: "invoices",
          profile: "billing",
          to: ["ada@example.org", "grace@example.org"],
          subject: "Invoice 2026-104",
          attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", size: 48213, sha256: "ab".repeat(32) }],
          status: "sent",
          failures: [],
          attempts: 1,
          createdAt: "2026-10-07T10:00:00.000Z",
          sentAt: "2026-10-07T10:00:01.000Z",
        },
      ],
      page: 1,
      perPage: 25,
      total: 1,
      hasNext: false,
    },
  },
};
const emptyLog: OutgoingMailState["log"] = { ...state.log, page: { ...state.log.page, items: [], total: 0 } };

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
  expect(en).toContain("Sender name: Cloud name");
  expect(en).toContain("500 recipients/day");
  expect(en).toContain("Default profile (No-reply)");
  expect(en).toContain(">Billing<");
  expect(en).toContain("No sending");
  expect(en).toContain("Does not request mail");
  expect(en).toContain("Not registered");
  expect(en).not.toContain("smtpPassword");
  // Core's system email cannot be redirected or blocked, so its row offers no access change.
  expect(en).toContain("System email, always the default profile");
  expect(en.split(">Change access<")).toHaveLength(state.apps.items.length);

  const de = render("de", state);
  expect(de).toContain("Absenderprofile");
  expect(de).toContain("Standardprofil (No-reply)");
  expect(de).toContain("Kein Versand");
  expect(de).toContain("Fordert keine Mail an");
  expect(de).toContain("Absendername: Cloud-Name");
  expect(de).toContain("Systemmails, immer über das Standardprofil");
});

test("lists apps that request mail before the others", () => {
  const html = render("en", state);
  expect(html.indexOf("Invoices")).toBeLessThan(html.indexOf("Files"));
  expect(html.indexOf("Core")).toBeLessThan(html.indexOf("Files"));
});

test("an installation without profiles explains what to do first", () => {
  const html = render("en", { profiles: [], apps: { defaultProfile: null, items: state.apps.items }, log: emptyLog });
  expect(html).toContain("No sender profile yet");
  expect(html).toContain("Add profile");
  expect(html).toContain(">Default profile<");
});

test("the send log shows metadata, retention, and status in English and German, never content", () => {
  const en = render("en", state);
  expect(en).toContain("Send log");
  expect(en).toContain("Text is kept for 90 days, the record for 365 days.");
  expect(en).toContain("Invoice 2026-104");
  expect(en).toContain("ada@example.org");
  expect(en).toContain("+1");
  expect(en).toContain(">Sent<");
  expect(en).toContain("Search recipients");
  expect(en).not.toContain("grace@example.org");

  const de = render("de", state);
  expect(de).toContain("Sendeprotokoll");
  expect(de).toContain("Der Text bleibt 90 Tage, der Eintrag 365 Tage erhalten.");
  expect(de).toContain(">Gesendet<");
  expect(de).toContain("Aufbewahrung");
});

test("an empty send log explains when mail appears", () => {
  const html = render("en", { ...state, log: emptyLog });
  expect(html).toContain("No mail sent yet");
  expect(html).toContain("Mail appears here as soon as an app sends it.");
});

test("each profile shows whether Cloud checks its mailbox for bounces, with a visible reason in English and German", () => {
  const imap = { host: "imap.example.org", port: 993, secure: true, user: "noreply@example.org", folder: "INBOX", hasPassword: true };
  const profiles = [
    profile({}),
    profile({ key: "pending", name: "Pending", isDefault: false, imap, bounces: { checkedAt: null, error: null } }),
    profile({ key: "checked", name: "Checked", isDefault: false, imap, bounces: { checkedAt: "2026-10-08T10:00:00.000Z", error: null } }),
    profile({
      key: "broken",
      name: "Broken",
      isDefault: false,
      imap,
      bounces: { checkedAt: "2026-10-08T10:00:00.000Z", error: "open_failed" },
    }),
    profile({
      key: "slow",
      name: "Slow",
      isDefault: false,
      imap,
      bounces: { checkedAt: "2026-10-08T10:00:00.000Z", error: "interrupted" },
    }),
  ];
  const en = render("en", { ...state, profiles });
  for (const label of ["No bounce check", "Bounce check pending", "Bounces checked"]) expect(en).toContain(label);
  expect(en).toContain("Bounce check failed: Cloud could not open the mailbox. Check the server, sign-in, TLS, and folder.");
  expect(en).toContain("Bounce check failed: The check ran out of time and continues with the next one.");
  // Stable codes are a transport contract, never the text an administrator reads.
  expect(en).not.toContain("open_failed");
  // Phones and tablets get the same line in the profile column; the server column only appears from lg.
  expect(en.match(/Bounce check failed: Cloud could not open the mailbox/g)).toHaveLength(2);
  const de = render("de", { ...state, profiles });
  for (const label of [
    "Keine Prüfung auf unzustellbare Mails",
    "Prüfung auf unzustellbare Mails ausstehend",
    "Unzustellbare Mails geprüft",
    "Prüfung auf unzustellbare Mails fehlgeschlagen: Cloud konnte das Postfach nicht öffnen. Prüfe Server, Anmeldung, TLS und Ordner.",
  ])
    expect(de).toContain(label);
});
