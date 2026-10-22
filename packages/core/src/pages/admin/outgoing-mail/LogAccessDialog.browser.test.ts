import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import { outgoingMailBrowserFixture } from "./OutgoingMail.browser-fixture";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof outgoingMailBrowserFixture>>;
beforeAll(async () => {
  fixture = await outgoingMailBrowserFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

test("real admin action opens the shared host; keyboard, scope, failed save and cancel work on desktop and phone", async () => {
  for (const { locale, width, height } of [
    { locale: "en", width: 1280, height: 900 },
    { locale: "de", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    const de = locale === "de";
    const errors: string[] = [];
    let release = () => {};
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${fixture.url}?locale=${locale}`);
      await page.locator('#outgoing-mail-fixture[data-ready="true"]').waitFor();
      const trigger = page.getByRole("button", { name: `${de ? "Aktionen für" : "Actions for"} Backoffice`, exact: true });
      const open = async () => {
        await trigger.click();
        await page
          .getByRole("menuitem", { name: de ? "Zugriff aufs Sendeprotokoll ändern" : "Change send log access", exact: true })
          .click();
        await page.locator("dialog[open] form").waitFor();
      };
      await open();
      const dialog = page.locator("dialog[open]");
      expect(await dialog.getAttribute("class")).toContain("k2b-dialog");
      const levels = dialog.getByRole("combobox");
      expect(await levels.allTextContents()).toEqual([
        de ? "Kein Zugriff" : "No access",
        de ? "Inhalt" : "Content",
        de ? "Metadaten" : "Metadata",
      ]);
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
      expect(await dialog.innerText()).toContain(de ? "bisherige und künftige" : "past and future");
      expect(await dialog.innerText()).not.toContain("invoices");
      const details = dialog.locator("summary");
      await details.focus();
      await page.keyboard.press("Enter");
      await dialog.locator("details[open]").waitFor();
      expect(await dialog.innerText()).toContain(de ? "Jeder Textabruf wird protokolliert" : "Each text read is audited");
      await details.press("Enter");
      await levels.first().focus();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      expect(await levels.first().textContent()).toBe(de ? "Metadaten" : "Metadata");
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/admin/core/outgoing-mail/apps/backoffice/log-access", async (route) => {
        await gate;
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ code: "invalid_profile", message: "Synthetic rejection" }),
        });
      });
      const submitted = page.waitForRequest("**/api/admin/core/outgoing-mail/apps/backoffice/log-access");
      await dialog.getByRole("button", { name: de ? "Speichern" : "Save", exact: true }).click();
      const request = await submitted;
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>("dialog[open] [role=combobox]")?.disabled);
      expect(request.postDataJSON()).toEqual({ apps: ["invoices", "legacy-crm", "customers"], contentApps: ["invoices"] });
      expect(await levels.first().isDisabled()).toBe(true);
      release();
      await dialog
        .getByText(de ? "Der Zugriff aufs Sendeprotokoll konnte nicht geändert werden" : "Could not change send log access", {
          exact: true,
        })
        .waitFor();
      expect(await levels.first().textContent()).toBe(de ? "Metadaten" : "Metadata");
      expect(await levels.first().isEnabled()).toBe(true);
      const bounds = await dialog.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
      const save = dialog.getByRole("button", { name: de ? "Speichern" : "Save", exact: true });
      await save.scrollIntoViewIfNeeded();
      expect(await save.isVisible()).toBe(true);
      await dialog.getByRole("button", { name: de ? "Abbrechen" : "Cancel", exact: true }).click();
      await page.locator("dialog[open]").waitFor({ state: "detached" });
      // The shared host restores focus in the next frame after removing the dialog.
      await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle());
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      await open();
      expect(await page.locator("dialog[open]").getByRole("combobox").first().textContent()).toBe(de ? "Kein Zugriff" : "No access");
      await page.keyboard.press("Escape");
      await page.locator("dialog[open]").waitFor({ state: "detached" });
      expect(await trigger.isVisible()).toBe(true);
      await page.waitForFunction((element) => element === document.activeElement, await trigger.elementHandle());
      expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      release();
      await page.close();
    }
  }
}, 60_000);
