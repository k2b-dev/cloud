import { afterAll, beforeAll, expect, test } from "bun:test";
import { launchBrowser } from "../packages/ui/test/browser";
import { unreadableAdminPreview } from "./fixtures/unreadable-admin/preview";

let preview: Awaited<ReturnType<typeof unreadableAdminPreview>>;
let browser: Awaited<ReturnType<typeof launchBrowser>>;
beforeAll(async () => {
  preview = await unreadableAdminPreview();
  browser = await launchBrowser();
}, 60000);
afterAll(async () => {
  await browser?.close();
  await preview?.server.stop(true);
});

for (const surface of ["storage", "database", "linux", "outgoing", "directory", "logs"] as const) {
  test(`${surface}: unreadable keys require intent and a failed save preserves the draft for recovery`, async () => {
    preview.reset();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${preview.server.url}?surface=${surface}`);
      if (surface === "directory") await page.getByRole("button", { name: "Contact directory", exact: true }).click();
      await page.getByText("Stored settings cannot be read", { exact: true }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const replacements = page.getByRole("checkbox", { name: /^Replace stored value/ });
      expect(await replacements.count()).toBe(surface === "database" || surface === "directory" ? 2 : 1);
      await replacements.first().check();
      if (surface === "storage") await page.getByLabel(/^Maximum file size \(MiB\)/).fill("60");
      // The Linux configuration is intentionally kept disabled; no range reservation is needed.
      const save = page.getByRole("button", { name: surface === "linux" ? "Disable identity assignment" : "Save", exact: true });
      await save.click();
      await page
        .getByText(surface === "linux" ? "The action could not be completed." : "Fictional save rejected. Review the draft and retry.", {
          exact: false,
        })
        .first()
        .waitFor();
      expect(await replacements.first().isChecked()).toBe(true);
      expect(preview.requests).toHaveLength(1);
      const sent = preview.requests[0]!.body;
      if (surface === "storage") {
        expect(sent).toEqual({ fileMiB: 60, replaceUnreadable: ["assistant.storage_file_mib"] });
        expect(await page.getByLabel(/^Maximum file size \(MiB\)/).inputValue()).toBe("60");
      }
      if (surface === "database") expect(sent).toEqual({ url: "", replaceUnreadable: ["assistant.rsql_url"] });
      if (surface === "directory")
        expect(sent).toEqual({ suggest: "contact.suggest", replaceUnreadable: ["mail.contact_directory.suggest"] });
      if (surface === "outgoing") expect(sent).toEqual({ contentDays: 30, replaceUnreadable: ["outgoing_mail.content_retention_days"] });
      if (surface === "logs") expect(sent).toEqual({ retentionDays: 30, replaceUnreadable: true });
      if (surface === "linux") expect(sent.replaceUnreadable).toBe(true);
      if (surface === "logs") await Promise.all([page.waitForNavigation(), save.click()]);
      else await save.click();
      await page.waitForFunction(() => !document.querySelector('button[aria-busy="true"]'));
      expect(preview.requests).toHaveLength(2);
      expect(preview.requests[1]!.body).toEqual(sent);
      if (surface === "directory") await page.locator("dialog[open]").waitFor({ state: "hidden" });
      else if (surface === "linux") await page.getByText("Stored settings cannot be read", { exact: true }).waitFor({ state: "hidden" });
      else if (surface !== "logs") await page.waitForFunction(() => document.body.dataset.saved === "true");
    } finally {
      await page.close();
    }
  }, 30000);
}

test("all six unreadable warnings fit desktop and phone in light and dark, in English and German", async () => {
  for (const surface of ["storage", "database", "linux", "outgoing", "directory", "logs"])
    for (const width of [390, 1280])
      for (const theme of ["light", "dark"])
        for (const locale of ["en", "de"]) {
          preview.reset();
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          try {
            await page.goto(`${preview.server.url}?surface=${surface}&theme=${theme}&locale=${locale}`);
            if (surface === "directory") await page.getByRole("button", { name: "Contact directory", exact: true }).click();
            await page
              .getByText(locale === "de" ? "Gespeicherte Einstellungen sind nicht lesbar" : "Stored settings cannot be read", {
                exact: true,
              })
              .waitFor();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          } finally {
            await page.close();
          }
        }
}, 60000);

test("unchecking an unreadable token replacement preserves the stored token despite the retained draft", async () => {
  preview.reset();
  const page = await browser.newPage();
  try {
    await page.goto(`${preview.server.url}?surface=database`);
    const replace = page.getByRole("checkbox", { name: /^Replace stored value/ }).nth(1);
    await replace.check();
    await page.getByLabel("API token", { exact: true }).fill("fictional-new-token");
    await replace.uncheck();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Fictional save rejected. Review the draft and retry.", { exact: true }).waitFor();
    expect(preview.requests[0]!.body).toEqual({ replaceUnreadable: [] });
  } finally {
    await page.close();
  }
});

for (const surface of ["storage", "database", "linux", "outgoing", "directory", "logs"] as const) {
  test(`${surface}: a late unreadable conflict refreshes metadata and recovers without losing the draft`, async () => {
    preview.reset();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${preview.server.url}?surface=${surface}&late=true`);
      if (surface === "directory") await page.getByRole("button", { name: "Contact directory", exact: true }).click();
      expect(await page.getByRole("checkbox", { name: /^Replace stored value/ }).count()).toBe(0);
      if (surface === "storage") await page.getByLabel(/^Maximum file size/).fill("60");
      if (surface === "database") await page.getByLabel("API token", { exact: true }).fill("fictional-new-token");
      if (surface === "linux") {
        await page.getByRole("button", { name: "Set up local identities", exact: true }).click();
        await page.getByLabel("Login shell", { exact: true }).fill("/bin/zsh");
        await page.getByLabel("First ID", { exact: true }).fill("200000");
        await page.getByLabel("Last ID", { exact: true }).fill("200100");
        await page.getByRole("checkbox", { name: "I have reserved this range for Cloud", exact: true }).check();
      }
      if (surface === "outgoing") await page.getByRole("spinbutton", { name: "Keep text for (days)", exact: true }).fill("60");
      if (surface === "directory") {
        await page.getByRole("combobox", { name: /^Suggest recipients/ }).click();
        await page.getByRole("option", { name: /Suggest alternate contacts/ }).click();
      }
      if (surface === "logs") await page.getByRole("spinbutton", { name: "Retention (days)", exact: true }).fill("45");
      const save = page.getByRole("button", { name: surface === "linux" ? "Check and save setup" : "Save", exact: true });
      await save.click();
      const replacement = page.getByRole("checkbox", { name: /^Replace stored value/ });
      await replacement.waitFor();
      expect(await replacement.count()).toBe(1);
      expect(preview.requests).toHaveLength(1);
      if (surface === "storage") expect(await page.getByLabel(/^Maximum file size/).inputValue()).toBe("60");
      if (surface === "database") {
        expect(await page.getByLabel("API token", { exact: true }).inputValue()).toBe("fictional-new-token");
        expect(preview.requests[0]!.body).toEqual({ token: "fictional-new-token", replaceUnreadable: [] });
      }
      if (surface === "linux") {
        expect(await page.getByLabel("Login shell", { exact: true }).inputValue()).toBe("/bin/zsh");
        expect(await page.getByRole("checkbox", { name: "I have reserved this range for Cloud", exact: true }).isChecked()).toBe(true);
      }
      if (surface === "outgoing")
        expect(await page.getByRole("spinbutton", { name: "Keep text for (days)", exact: true }).inputValue()).toBe("60");
      if (surface === "directory")
        expect(await page.getByRole("combobox", { name: /^Suggest recipients/ }).textContent()).toContain("Suggest alternate contacts");
      if (surface === "logs") expect(await page.getByRole("spinbutton", { name: "Retention (days)", exact: true }).inputValue()).toBe("45");
      await replacement.check();
      if (surface === "logs") await Promise.all([page.waitForNavigation(), save.click()]);
      else await save.click();
      if (surface === "directory") await page.locator("dialog[open]").waitFor({ state: "hidden" });
      else if (surface === "linux") await replacement.waitFor({ state: "hidden" });
      else if (surface !== "logs") await page.waitForFunction(() => document.body.dataset.saved === "true");
      expect(preview.requests).toHaveLength(2);
      expect(preview.requests[1]!.body.replaceUnreadable).toEqual(
        surface === "linux" || surface === "logs"
          ? true
          : [
              surface === "storage"
                ? "assistant.storage_file_mib"
                : surface === "database"
                  ? "assistant.rsql_api_token"
                  : surface === "outgoing"
                    ? "outgoing_mail.content_retention_days"
                    : "mail.contact_directory.suggest",
            ],
      );
    } finally {
      await page.close();
    }
  }, 30000);
}
