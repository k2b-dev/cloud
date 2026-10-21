import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import type { startConversationPanelFixture } from "./ChatPanel.browser-fixture";
import { nora, viewer } from "./ChatWorkspace.browser-fixture";

let fixture: Awaited<ReturnType<typeof startConversationPanelFixture>>;
let browser: Browser;
const root = mkdtempSync(resolve(tmpdir(), "conversation-panel-ssr-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
beforeAll(async () => {
  const { startConversationPanelFixture } = await import("./ChatPanel.browser-fixture");
  fixture = await startConversationPanelFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.stop();
  rmSync(root, { recursive: true, force: true });
});
for (const width of [1440, 390]) {
  test(`Chat reads and sends in the real panel, restores its draft and opens full view at ${width}px`, async () => {
    fixture.backend.reset();
    const chat = fixture.backend.addChat({ members: [viewer, nora], name: "Project planning", count: 3, end: fixture.backend.now() });
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en", timezoneId: "UTC" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "true");
      await page.locator("#open-chat").click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator(`a[href="/app/chat/panel/c/${chat}"]:visible`).click();
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      const composer = panel.locator('textarea:not([aria-hidden="true"])');
      await composer.fill("A message sent from the panel");
      await panel.getByRole("button", { name: "Send message", exact: true }).click();
      await panel.locator('[data-status="sent"]').filter({ hasText: "A message sent from the panel" }).waitFor();
      expect(fixture.backend.posted).toHaveLength(1);
      await composer.fill("Unsent draft for this conversation");
      await page.locator('[data-cloud-panel-provider="second"]').click();
      await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
      await page.locator('[data-cloud-panel-provider="chat"]').click();
      await panel.locator(`a[href="/app/chat/c/${chat}"]`).waitFor();
      expect(await composer.inputValue()).toBe("Unsent draft for this conversation");
      expect(await panel.locator(".cloud-app-canvas").count()).toBe(0);
      if (process.env.PANEL_SCREENSHOTS) {
        mkdirSync(process.env.PANEL_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.PANEL_SCREENSHOTS, `chat-result-light-${width}.png`) });
      }
      await panel.getByRole("link", { name: "Open full view", exact: true }).click();
      await page.waitForURL(`**/app/chat/c/${chat}`);
      await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "true");
      expect(await page.locator('textarea:not([aria-hidden="true"])').inputValue()).toBe("Unsent draft for this conversation");
      expect(fixture.backend.posted).toHaveLength(1);
    } finally {
      await context.close();
    }
  }, 30_000);
}

for (const width of [1440, 390]) {
  test(`Assistant saves a new panel draft, resumes it and resolves a lost send at ${width}px`, async () => {
    fixture.assistant.reset();
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en", timezoneId: "UTC" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "true");
      await page.locator("#open-chat").click();
      await page.locator('[data-cloud-panel-provider="assistant"]').click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      const composer = panel.locator('textarea:not([aria-hidden="true"])');
      await composer.fill("Assistant draft from this panel");
      expect(await composer.inputValue()).toBe("Assistant draft from this panel");
      await panel.getByText("Draft not saved yet", { exact: true }).waitFor({ state: "visible" });
      await page.locator('[data-cloud-panel-provider="second"]').click();
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
      await panel.getByText("Draft not saved yet", { exact: true }).waitFor({ state: "hidden" });
      expect(fixture.assistant.conversations.size).toBe(1);
      await page.locator('[data-cloud-panel-provider="second"]').click();
      await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
      await page.locator('[data-cloud-panel-provider="assistant"]').click();
      await composer.waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")
            ?.contentDocument?.querySelector<HTMLTextAreaElement>("textarea")?.value === "Assistant draft from this panel",
      );
      if (width === 1440) fixture.assistant.loseSend();
      else fixture.assistant.rejectSend();
      await panel.getByRole("button", { name: "Send message", exact: true }).click();
      await panel.getByText("Message status is unclear", { exact: true }).waitFor();
      expect(fixture.assistant.submitted()).toBe(width === 1440 ? 1 : 0);
      await page.locator('[data-cloud-panel-provider="second"]').click();
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
      await panel.getByRole("button", { name: width === 1440 ? "Check message status" : "Retry the same message", exact: true }).click();
      await panel.getByText("Message status is unclear", { exact: true }).waitFor({ state: "hidden" });
      expect(fixture.assistant.submitted()).toBe(1);
      expect(fixture.assistant.conversations.size).toBe(1);
      const submissions = fixture.assistant.requests.filter((request) => request.path.endsWith("/turns"));
      expect(submissions).toHaveLength(width === 1440 ? 1 : 2);
      if (submissions.length === 2) expect(submissions[1]!.body).toEqual(submissions[0]!.body);
      await panel.getByText("The project plan is ready for your review.", { exact: true }).waitFor();
      expect(await composer.inputValue()).toBe("");
      await composer.fill("Next unsent draft");
      await panel.getByText("Draft not saved yet", { exact: true }).waitFor({ state: "hidden" });
      await page.locator("[data-cloud-panel-close]").click();
      await page.locator("#open-chat").click();
      await page.locator('[data-cloud-panel-provider="assistant"]').click();
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")
            ?.contentDocument?.querySelector<HTMLTextAreaElement>("textarea")?.value === "Next unsent draft",
      );
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "true");
      if (width < 640) {
        await page.locator("#open-chat").click();
        await page.locator('[data-cloud-panel-provider="assistant"]').click();
      }
      await page.waitForFunction(
        () =>
          document
            .querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")
            ?.contentDocument?.querySelector<HTMLTextAreaElement>("textarea")?.value === "Next unsent draft",
      );
      await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
      await panel.getByRole("dialog").waitFor();
      await panel.getByRole("dialog").press("Escape");
      await panel.getByRole("dialog").waitFor({ state: "hidden" });
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
      const box = await composer.boundingBox();
      expect(box && box.y >= 0 && box.y + box.height <= 900).toBe(true);
      if (width === 1440) {
        await page.getByRole("textbox", { name: "Host note", exact: true }).fill("Host stays usable");
      }
      if (process.env.PANEL_SCREENSHOTS) {
        mkdirSync(process.env.PANEL_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.PANEL_SCREENSHOTS, `assistant-result-light-${width}.png`) });
      }
      await page.evaluate(() => {
        document.documentElement.classList.remove("light");
        document.documentElement.classList.add("dark");
        window.dispatchEvent(new Event("cloud:theme-preference"));
      });
      await panel.locator("html.dark").waitFor();
      if (process.env.PANEL_SCREENSHOTS)
        await page.screenshot({ path: resolve(process.env.PANEL_SCREENSHOTS, `assistant-result-dark-${width}.png`) });
      await panel.getByRole("link", { name: "Open full view", exact: true }).click();
      await page.waitForURL("**/app/assistant?conversation=*");
      await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "true");
      expect(await page.locator('textarea:not([aria-hidden="true"])').inputValue()).toBe("Next unsent draft");
      expect(fixture.assistant.submitted()).toBe(1);
    } catch (error) {
      await page.screenshot({ path: resolve(tmpdir(), `assistant-panel-failure-${width}.png`) });
      console.error(JSON.stringify({ requests: fixture.assistant.requests, conversations: [...fixture.assistant.conversations.values()] }));

      throw error;
    } finally {
      await context.close();
    }
  }, 45_000);
}

test("Assistant keeps an uploading panel mounted and restores the confirmed file draft", async () => {
  fixture.assistant.reset();
  const release = fixture.assistant.holdUpload();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en", timezoneId: "UTC" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  try {
    await page.goto(fixture.url + "app/fixture");
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "true");
    await page.locator("#open-chat").click();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    await panel.locator('html[data-fixture-ready="true"]').waitFor();
    await panel
      .locator('input[type="file"]')
      .setInputFiles({ name: "planning.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic project notes") });
    await panel.getByText("planning.txt", { exact: true }).waitFor();
    const upload = page.waitForRequest((request) => request.url().endsWith("/files") && request.method() === "POST");
    await panel.getByRole("button", { name: "Save drafts", exact: true }).click();
    await upload;
    await page.locator('[data-cloud-panel-provider="second"]').click();
    expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
    release();
    await panel.getByText("Draft not saved yet", { exact: true }).waitFor({ state: "hidden" });
    await page.locator('[data-cloud-panel-provider="second"]').click();
    await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    await panel.getByText("planning.txt", { exact: true }).waitFor();
    expect(fixture.assistant.uploads()).toBe(1);
    expect([...fixture.assistant.conversations.values()][0]!.draft.content).toEqual([
      { type: "file", path: "/uploads/planning.txt", mediaType: "text/plain;charset=utf-8", size: 23, version: 1 },
    ]);
  } finally {
    release();
    await context.close();
  }
}, 30_000);
