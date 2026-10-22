import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { ok } from "@k2b/stdlib";
import type { Browser } from "playwright";
import { z } from "zod";
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
    fixture.allowContext(width === 1440);
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
      if (width === 1440) expect(await page.locator("[data-cloud-panel-frame]").getAttribute("src")).toContain("cloud_panel_context");
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
      fixture.allowContext(false);
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

for (const provider of ["chat", "assistant"] as const) {
  test(`${provider} disables SSR editing until its panel guard and drafts are ready`, async () => {
    fixture.backend.reset();
    fixture.assistant.reset();
    const id = fixture.backend.addChat({ members: [viewer, nora], name: "SSR guard", count: 1, end: fixture.backend.now() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
    const page = await context.newPage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdScripts = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (holdScripts && request.resourceType() === "script" && request.frame().parentFrame()) await gate;
      await route.continue();
    });
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      holdScripts = true;
      if (provider === "chat") {
        // Force a document load: an already mounted Chat handles ordinary internal clicks in place.
        const frame = page.frames().find((frame) => frame.url().includes("/app/chat/panel"));
        if (!frame) throw new Error("Missing real Chat panel frame");
        await frame.goto(fixture.url + `app/chat/panel/c/${id}`, { waitUntil: "commit" });
      } else await page.locator('[data-cloud-panel-provider="assistant"]').click();
      const composer = panel.locator('textarea:not([aria-hidden="true"])');
      await composer.waitFor();
      expect(await composer.isDisabled()).toBe(true);
      expect(await panel.locator('html[data-fixture-ready="true"]').count()).toBe(0);
      expect(await panel.getByRole("link", { name: "Open full view", exact: true }).getAttribute("target")).toBe("_top");
      release();
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      expect(await panel.getByRole("link", { name: "Open full view", exact: true }).getAttribute("target")).toBeNull();
      await composer.fill("Input after guard registration");
      expect(await composer.inputValue()).toBe("Input after guard registration");
    } finally {
      release();
      await context.close();
    }
  }, 30_000);
}

test("Assistant keeps the chosen conversation when an older empty creation completes", async () => {
  fixture.assistant.reset();
  fixture.assistant.addConversation("Chat2B", "Chosen conversation B");
  const release = fixture.assistant.holdCreate();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  try {
    await page.goto(fixture.url + "app/fixture");
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.locator("#open-chat").click();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    await panel.locator('html[data-fixture-ready="true"]').waitFor();
    await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
    await panel.getByRole("dialog").getByText("New chat", { exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")?.contentDocument?.querySelector("textarea")?.disabled ===
        true,
    );
    await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
    await panel.getByRole("dialog").getByText("Chosen conversation B", { exact: true }).click();
    await panel.locator('a[href="/app/assistant?conversation=Chat2B"]').waitFor();
    release();
    await panel.locator('textarea:not([aria-hidden="true"]):enabled').waitFor();
    await page.locator('[data-cloud-panel-provider="second"]').click();
    await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    await panel.locator('a[href="/app/assistant?conversation=Chat2B"]').waitFor();
    expect(fixture.assistant.conversations.size).toBe(2);
  } finally {
    release();
    await context.close();
  }
}, 30_000);

test("Assistant locks a lost queue receipt and checks it without saving or enqueueing again", async () => {
  fixture.assistant.reset();
  fixture.assistant.addConversation("Chat2B");
  fixture.assistant.run("Chat2B");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  try {
    await context.addInitScript(() => {
      if (location.pathname === "/app/fixture") sessionStorage.setItem("cloud.assistant.panel:fixture-user", "Chat2B");
    });
    await page.goto(fixture.url + "app/fixture");
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.locator("#open-chat").click();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    const composer = panel.locator('textarea:not([aria-hidden="true"])');
    await composer.fill("Queued follow-up");
    fixture.assistant.loseSend();
    await panel.getByRole("button", { name: "Queue message", exact: true }).click();
    await panel.getByText("Message status is unclear", { exact: true }).waitFor();
    expect(fixture.assistant.queued()).toBe(1);
    expect(await composer.isDisabled()).toBe(true);
    expect(await panel.getByRole("button", { name: "Keep local", exact: true }).count()).toBe(0);
    const writes = fixture.assistant.requests.filter((r) => r.path.endsWith("/draft") || r.path.endsWith("/turns")).length;
    await panel.getByRole("button", { name: "Save drafts", exact: true }).click();
    await page.locator('[data-cloud-panel-provider="second"]').click();
    expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
    await panel.getByRole("button", { name: "Check message status", exact: true }).click();
    await panel.getByText("Message status is unclear", { exact: true }).waitFor({ state: "hidden" });
    expect(await composer.inputValue()).toBe("");
    expect(fixture.assistant.requests.filter((r) => r.path.endsWith("/draft") || r.path.endsWith("/turns"))).toHaveLength(writes);
    expect(fixture.assistant.queued()).toBe(1);
    await page.locator('[data-cloud-panel-provider="second"]').click();
    await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
  } finally {
    await context.close();
  }
}, 30_000);

test("Assistant offers a confirmed local exit when message status remains inaccessible", async () => {
  fixture.assistant.reset();
  fixture.assistant.addConversation("Chat2A", "Other draft A");
  fixture.assistant.addConversation("Chat2B", "Unclear message B");
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, locale: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  try {
    await page.goto(fixture.url + "app/fixture");
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.evaluate(() => sessionStorage.setItem("cloud.assistant.panel:fixture-user", "Chat2A"));
    await page.locator("#open-chat").click();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    const composer = panel.locator('textarea:not([aria-hidden="true"])');
    await composer.fill("Other conversation keeps this draft");
    await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
    await panel.getByRole("dialog").getByText("Unclear message B", { exact: true }).click();
    await panel.locator('a[href="/app/assistant?conversation=Chat2B"]').waitFor();
    await composer.fill("Message with permanently unclear status");
    fixture.assistant.rejectSend();
    await panel.getByRole("button", { name: "Send message", exact: true }).click();
    await panel.getByText("Message status is unclear", { exact: true }).waitFor();
    fixture.assistant.denyStatus();
    await panel.getByRole("button", { name: "Check message status", exact: true }).click();
    const leave = panel.getByRole("button", { name: "Leave despite unclear message status", exact: true });
    expect(await leave.isDisabled()).toBe(true);
    await panel.getByRole("button", { name: "Save drafts", exact: true }).click();
    await leave.click();
    expect(fixture.assistant.conversations.get("Chat2A")!.draft.content).toEqual([
      { type: "text", text: "Other conversation keeps this draft" },
    ]);
    await panel
      .getByRole("dialog")
      .getByText(/Leaving does not cancel it/)
      .waitFor();
    if (process.env.PANEL_SCREENSHOTS)
      await page.screenshot({
        path: resolve(process.env.PANEL_SCREENSHOTS, "assistant-unknown-exit-light-390.png"),
        animations: "disabled",
      });
    await panel.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await composer.inputValue()).toBe("Message with permanently unclear status");
    expect(await composer.isDisabled()).toBe(true);
    const writes = fixture.assistant.requests.length;
    await page.locator("[data-cloud-panel-close]").click();
    expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
    await leave.click();
    await panel.getByRole("dialog").getByRole("button", { name: "Leave despite unclear message status", exact: true }).click();
    await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
    expect(fixture.assistant.requests).toHaveLength(writes);
    expect(fixture.assistant.submitted()).toBe(0);
  } finally {
    await context.close();
  }
}, 30_000);

for (const alsoSend of [false, true]) {
  test(`Assistant retains an unknown empty creation until an explicit exit (unknown send: ${alsoSend})`, async () => {
    fixture.assistant.reset();
    if (alsoSend) fixture.assistant.addConversation("Chat2B", "Existing B");
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      await page.locator('[data-cloud-panel-provider="assistant"]').click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      fixture.assistant.loseCreate();
      await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
      await panel.getByRole("dialog").getByText("New chat", { exact: true }).click();
      await panel.getByText("Conversation creation is unclear", { exact: true }).waitFor();
      await page.locator("[data-cloud-panel-close]").click();
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
      fixture.assistant.denyCreate();
      await panel.getByRole("button", { name: "Retry creating conversation", exact: true }).click();
      const leave = panel.getByRole("button", {
        name: alsoSend ? "Leave despite unclear message status" : "Leave despite unclear creation",
        exact: true,
      });
      const composer = panel.locator('textarea:not([aria-hidden="true"])');
      await panel.getByText("Creation unavailable", { exact: true }).waitFor();
      const creations = fixture.assistant.requests.filter((r) => r.path === "/api/ai/conversations");
      expect(creations).toHaveLength(2);
      expect(creations[1]!.body).toEqual(creations[0]!.body);
      if (alsoSend) {
        await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
        await panel.getByRole("dialog").getByText("Existing B", { exact: true }).click();
        await composer.fill("Another uncertain send");
        fixture.assistant.rejectSend();
        await panel.getByRole("button", { name: "Send message", exact: true }).click();
        await panel.getByText("Message status is unclear", { exact: true }).waitFor();
      } else {
        await composer.fill("A newer draft must be protected");
        expect(await leave.isDisabled()).toBe(true);
        await composer.fill("");
      }
      await leave.click();
      await panel
        .getByRole("dialog")
        .getByText(/The conversation may already exist/)
        .waitFor();
      if (!alsoSend && process.env.PANEL_SCREENSHOTS)
        await page.screenshot({
          path: resolve(process.env.PANEL_SCREENSHOTS, "assistant-unknown-create-light-1440.png"),
          animations: "disabled",
        });
      if (alsoSend)
        await panel
          .getByRole("dialog")
          .getByText(/Leaving does not cancel it/)
          .waitFor();
      await panel.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      await page.locator("[data-cloud-panel-close]").click();
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
      const writes = fixture.assistant.requests.length;
      await leave.click();
      await panel
        .getByRole("dialog")
        .getByRole("button", { name: alsoSend ? "Leave despite unclear message status" : "Leave despite unclear creation", exact: true })
        .click();
      await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
      expect(fixture.assistant.requests).toHaveLength(writes);
      expect(fixture.assistant.submitted()).toBe(0);
    } finally {
      await context.close();
    }
  }, 30_000);
}

test("a late server acceptance after a confirmed exit never triggers another submission", async () => {
  fixture.assistant.reset();
  const release = fixture.assistant.holdSend();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  let accepted!: () => void;
  const lateAcceptance = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  await page.route("**/api/ai/conversations/*/turns", async (route) => {
    const original = route.fetch();
    await route.fulfill({ status: 502, body: "Response lost while original request is in flight", contentType: "text/plain" });
    await original;
    accepted();
  });
  try {
    await page.goto(fixture.url + "app/fixture");
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.locator("#open-chat").click();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    await panel.locator('textarea:not([aria-hidden="true"])').fill("Late acceptance");
    await panel.getByRole("button", { name: "Send message", exact: true }).click();
    await panel.getByText("Message status is unclear", { exact: true }).waitFor();
    expect(fixture.assistant.submitted()).toBe(0);
    await panel.getByRole("button", { name: "Leave despite unclear message status", exact: true }).click();
    await panel.getByRole("dialog").getByRole("button", { name: "Leave despite unclear message status", exact: true }).click();
    await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
    release();
    await lateAcceptance;
    expect(fixture.assistant.submitted()).toBe(1);
    expect(fixture.assistant.requests.filter((r) => r.path.endsWith("/turns"))).toHaveLength(1);
  } finally {
    release();
    await context.close();
  }
}, 30_000);

test("Assistant protects editing while only PanelRuntime is delayed", async () => {
  fixture.assistant.reset();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${fixture.panelRuntimePath}`, async (route) => {
    if (route.request().frame().url().includes("/app/assistant/panel")) await gate;
    await route.continue();
  });
  const releaseCreate = fixture.assistant.holdCreate();
  try {
    await page.goto(fixture.url + "app/fixture");
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.locator("#open-chat").click();
    await page.locator('[data-cloud-panel-provider="assistant"]').click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    await panel.locator('html[data-fixture-ready="true"]').waitFor();
    const composer = panel.locator('textarea:not([aria-hidden="true"])');
    await composer.fill("Input before the runtime is ready");
    expect(await panel.locator("[data-cloud-panel-ready]").count()).toBe(0);
    await page.locator('[data-cloud-panel-provider="second"]').click();
    expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
    await page.locator("[data-cloud-panel-close]").click();
    expect(await page.locator("[data-cloud-panel-frame]").count()).toBe(1);
    expect(await composer.inputValue()).toBe("Input before the runtime is ready");
    await panel.getByRole("link", { name: "Open full view", exact: true }).click();
    expect(await composer.inputValue()).toBe("Input before the runtime is ready");
    expect(new URL(page.url()).pathname).toBe("/app/fixture");
    releaseCreate();
    await panel.getByText("Draft not saved yet", { exact: true }).waitFor({ state: "hidden" });
    await panel.getByRole("link", { name: "Open full view", exact: true }).click();
    await page.waitForURL("**/app/assistant?conversation=*", { waitUntil: "domcontentloaded" });
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    expect(await page.locator('textarea:not([aria-hidden="true"])').inputValue()).toBe("Input before the runtime is ready");
  } finally {
    release();
    releaseCreate();
    await context.close();
  }
}, 30_000);

for (const provider of ["chat", "assistant"] as const) {
  test(`${provider} can leave an empty panel when session storage is unavailable`, async () => {
    fixture.backend.reset();
    fixture.assistant.reset();
    const id = fixture.backend.addChat({ members: [viewer, nora], name: "Storage recovery", count: 1, end: fixture.backend.now() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
    await context.addInitScript(() => {
      if (location.pathname.includes("/panel"))
        Object.defineProperty(window, "sessionStorage", {
          get() {
            throw new Error("Synthetic unavailable storage");
          },
        });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      if (provider === "assistant") await page.locator('[data-cloud-panel-provider="assistant"]').click();
      else await panel.locator(`a[href="/app/chat/panel/c/${id}"]:visible`).click();
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      expect(await panel.locator('textarea:not([aria-hidden="true"])').isDisabled()).toBe(true);
      const notice = panel.getByText(provider === "chat" ? "Draft could not be kept in this tab" : "Draft not saved yet", { exact: true });
      await notice.waitFor();
      const retry = panel.getByRole("button", { name: provider === "chat" ? "Try again" : "Save drafts", exact: true });
      await retry.click();
      expect(await retry.isEnabled()).toBe(true);
      expect(await notice.isVisible()).toBe(true);
      expect(await panel.locator('textarea:not([aria-hidden="true"])').isDisabled()).toBe(true);
      await page.locator("[data-cloud-panel-close]").click();
      await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
      await page.locator("#open-chat").click();
      if (provider === "assistant") await page.locator('[data-cloud-panel-provider="assistant"]').click();
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator('[data-cloud-panel-provider="second"]').click();
      await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
    } finally {
      await context.close();
    }
  }, 30_000);
}

test("Chat protects a draft after a storage write failure and releases it only after retry", async () => {
  fixture.backend.reset();
  const id = fixture.backend.addChat({ members: [viewer, nora], name: "Storage write recovery", count: 1, end: fixture.backend.now() });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  try {
    await page.goto(fixture.url + "app/fixture");
    await page.locator('html[data-fixture-ready="true"]').waitFor();
    await page.locator("#open-chat").click();
    const panel = page.frameLocator("[data-cloud-panel-frame]");
    await panel.locator(`a[href="/app/chat/panel/c/${id}"]:visible`).click();
    await panel.locator('html[data-fixture-ready="true"]').waitFor();
    await panel.locator('textarea:not([aria-hidden="true"])').evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new Error("Synthetic quota failure");
      };
      window.addEventListener(
        "restore-storage",
        () => {
          Storage.prototype.setItem = original;
        },
        { once: true },
      );
    });
    const composer = panel.locator('textarea:not([aria-hidden="true"])');
    await composer.fill("Draft survives failed storage");
    await page.locator("[data-cloud-panel-close]").click();
    expect(await page.locator("[data-cloud-panel-frame]").count()).toBe(1);
    await page.locator('[data-cloud-panel-provider="second"]').click();
    expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("chat");
    expect(await composer.inputValue()).toBe("Draft survives failed storage");
    await composer.evaluate(() => window.dispatchEvent(new Event("restore-storage")));
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator('[data-cloud-panel-provider="second"]').click();
    await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
    await page.locator('[data-cloud-panel-provider="chat"]').click();
    await composer.waitFor();
    expect(await composer.inputValue()).toBe("Draft survives failed storage");
  } finally {
    await context.close();
  }
}, 30_000);

for (const preparation of ["resource", "image"] as const) {
  for (const unknownCreation of [false, true]) {
    test(`Assistant protects pending ${preparation} preparation (unknown creation: ${unknownCreation})`, async () => {
      fixture.assistant.reset();
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
      const page = await context.newPage();
      page.setDefaultTimeout(8_000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ref = { type: "notebooks.note", id: "3rQGbm" };
      if (preparation === "resource") {
        await page.route("**/api/capabilities/v1/catalog?*", (route) =>
          route.fulfill({
            json: {
              protocolVersion: 2,
              apps: [
                {
                  appId: "notebooks",
                  appName: "Notebooks",
                  appDescription: "Synthetic notes",
                  appIcon: "ti ti-notebook",
                  manifest: {
                    protocolVersion: 2,
                    appId: "notebooks",
                    manifestHash: "a".repeat(64),
                    types: [
                      { localId: "note", title: "Synthetic note", description: "A note", icon: "ti ti-file-text", reader: "note.read" },
                    ],
                    queries: [
                      {
                        localId: "note.read",
                        title: "Read note",
                        description: "Read",
                        inputSchema: {},
                        dataSchema: {},
                        schemaHash: "b".repeat(64),
                        openWorld: false,
                      },
                    ],
                    actions: [],
                    commands: [],
                  },
                },
              ],
              page: { hasMore: false },
            },
          }),
        );
        await page.route("**/api/capabilities/v1/queries/notebooks/note.read", async (route) => {
          await gate;
          await route.fulfill({
            json: {
              data: { id: ref.id, title: "Synthetic note" },
              refs: [ref],
              links: [{ rel: "open", href: "/app/notebooks/notes/3rQGbm" }],
            },
          });
        });
      }
      try {
        await page.goto(fixture.url + "app/fixture");
        await page.locator('html[data-fixture-ready="true"]').waitFor();
        await page.locator("#open-chat").click();
        await page.locator('[data-cloud-panel-provider="assistant"]').click();
        const panel = page.frameLocator("[data-cloud-panel-frame]");
        await panel.locator('html[data-fixture-ready="true"]').waitFor();
        if (unknownCreation) {
          fixture.assistant.loseCreate();
          await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
          await panel.getByRole("dialog").getByText("New chat", { exact: true }).click();
          await panel.getByText("Conversation creation is unclear", { exact: true }).waitFor();
        }
        const composer = panel.locator('textarea:not([aria-hidden="true"])');
        await composer.fill("Text and attachment stay together");
        if (preparation === "resource") {
          const reading = page.waitForRequest("**/api/capabilities/v1/queries/notebooks/note.read");
          await composer.evaluate((element, ref) => {
            const clipboardData = new DataTransfer();
            clipboardData.setData(
              "application/vnd.k2b.cloud-resource-ref+json",
              JSON.stringify({ version: 1, cloudUrl: location.origin, ref }),
            );
            element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
          }, ref);
          await reading;
        } else {
          // Install once in the loaded frame: WebKit can run init scripts in both
          // about:blank and its replacement document, nesting a delayed reader.
          await composer.evaluate(() => {
            const read = FileReader.prototype.readAsDataURL;
            FileReader.prototype.readAsDataURL = function (file) {
              document.documentElement.dataset.imageReading = "true";
              window.addEventListener(
                "release-image",
                () => {
                  document.documentElement.dataset.imageReleased = "true";
                  document.documentElement.dataset.imageReadCalls = String(
                    Number(document.documentElement.dataset.imageReadCalls ?? 0) + 1,
                  );
                  this.addEventListener("load", () => {
                    document.documentElement.dataset.imageLoads = String(Number(document.documentElement.dataset.imageLoads ?? 0) + 1);
                  });
                  this.addEventListener("loadend", () => {
                    document.documentElement.dataset.imageReadEnd = this.error?.message ?? "ok";
                  });
                  read.call(this, file);
                },
                { once: true },
              );
            };
          });
          await panel.locator('input[type="file"]').setInputFiles({
            name: "synthetic.png",
            mimeType: "image/png",
            buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2hAAAAABJRU5ErkJggg==", "base64"),
          });
          await panel.locator('html[data-image-reading="true"]').waitFor();
        }
        expect(await composer.isDisabled()).toBe(true);
        await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
        const newChat = panel.getByRole("dialog").getByRole("button", { name: "New chat", exact: true });
        expect(await newChat.isDisabled()).toBe(true);
        // Even a synthetic activation cannot change the identity of the draft being prepared.
        await newChat.dispatchEvent("click");
        expect(fixture.assistant.conversations.size).toBe(unknownCreation ? 1 : 0);
        await panel.getByRole("dialog").press("Escape");
        expect(await panel.getByRole("button", { name: "Save drafts", exact: true }).isDisabled()).toBe(true);
        if (unknownCreation)
          expect(await panel.getByRole("button", { name: "Leave despite unclear creation", exact: true }).isDisabled()).toBe(true);
        await page.locator('[data-cloud-panel-provider="second"]').click();
        expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
        await page.locator("[data-cloud-panel-close]").click();
        expect(await page.locator("[data-cloud-panel-frame]").count()).toBe(1);
        release();
        if (preparation === "image") {
          expect(await panel.locator("html").getAttribute("data-image-read-calls")).toBeNull();
          await composer.evaluate(() => window.dispatchEvent(new Event("release-image")));
          await panel.locator('html[data-image-read-end="ok"]').waitFor();
          expect(await panel.locator("html").getAttribute("data-image-read-calls")).toBe("1");
          expect(await panel.locator("html").getAttribute("data-image-loads")).toBe("1");
        }
        await panel.getByText(preparation === "resource" ? "Synthetic note" : "synthetic.png", { exact: true }).waitFor();
        await panel.getByRole("button", { name: "Save drafts", exact: true }).click();
        await panel.getByText("Draft not saved yet", { exact: true }).waitFor({ state: "hidden" });
        await page.locator('[data-cloud-panel-provider="second"]').click();
        await page.locator('#cloud-panel[data-provider="second"][data-state="ready"]').waitFor();
        await page.locator('[data-cloud-panel-provider="assistant"]').click();
        await panel.getByText(preparation === "resource" ? "Synthetic note" : "synthetic.png", { exact: true }).waitFor();
        expect(fixture.assistant.conversations.size).toBe(1);
        expect(await composer.inputValue()).toBe("Text and attachment stay together");
        const saved = [...fixture.assistant.conversations.values()][0]!.draft.content;
        expect(saved).toContainEqual({ type: "text", text: "Text and attachment stay together" });
        expect(saved.some((part) => part.type !== "text")).toBe(true);
      } catch (error) {
        console.error(await page.frameLocator("[data-cloud-panel-frame]").locator("body").innerText());
        console.error(
          await page
            .frameLocator("[data-cloud-panel-frame]")
            .locator("html")
            .evaluate((element) => ({
              dataset: { ...element.dataset },
              attachments: element.querySelector(".k2b-chat-composer__attachments")?.outerHTML,
              disabled: element.querySelector("textarea")?.disabled,
            })),
        );
        throw error;
      } finally {
        release();
        await context.close();
      }
    }, 30_000);
  }
}

for (const provider of ["chat", "assistant"] as const) {
  test(`${provider} opens the SSR full-view link in the host before provider scripts load`, async () => {
    fixture.backend.reset();
    fixture.assistant.reset();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() === "script" && route.request().frame().parentFrame()) await gate;
      await route.continue();
    });
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      if (provider === "assistant") await page.locator('[data-cloud-panel-provider="assistant"]').click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      const link = panel.getByRole("link", { name: "Open full view", exact: true });
      await link.waitFor();
      expect(await panel.locator('html[data-fixture-ready="true"]').count()).toBe(0);
      await link.click();
      await page.waitForURL(`**/app/${provider}`, { waitUntil: "domcontentloaded" });
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      expect(new URL(page.url()).pathname).toBe(`/app/${provider}`);
      expect(await page.locator(".cloud-app-canvas").count()).toBe(1);
    } finally {
      release();
      await context.close();
    }
  }, 30_000);
}

for (const width of [1440, 390]) {
  test(`Assistant create replay preserves another tab's saved draft at ${width}px`, async () => {
    fixture.assistant.reset();
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en", timezoneId: "UTC" });
    await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: fixture.url }]);
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    let releaseTarget!: () => void;
    const targetSave = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      await page.locator('[data-cloud-panel-provider="assistant"]').click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      const composer = panel.locator('textarea:not([aria-hidden="true"])');
      await composer.fill("Local draft A");
      fixture.assistant.loseCreate();
      await panel.getByRole("button", { name: "Save drafts", exact: true }).click();
      await panel.getByText("Conversation creation is unclear", { exact: true }).waitFor();
      const created = [...fixture.assistant.conversations.values()][0]!;
      // A desktop tab also restores the panel. Its writes must not satisfy the full-view save below.
      if (width === 1440) fixture.assistant.addConversation("Chat2C");
      const other = await context.newPage();
      const draftUrl = `${fixture.url}api/ai/conversations/${created.id}/draft`;
      const expectedRevision = created.draft.revision;
      if (width === 1440)
        await other.route(draftUrl, async (route) => {
          if (route.request().method() === "PUT") await targetSave;
          await route.continue();
        });
      await other.goto(`${fixture.url}app/assistant?conversation=${created.id}`);
      await other.locator('html[data-fixture-ready="true"]').waitFor();
      const saved = other.waitForResponse((response) => {
        const request = response.request();
        return (
          response.url() === draftUrl &&
          request.method() === "PUT" &&
          request.frame() === other.mainFrame() &&
          request.postDataJSON().expectedRevision === expectedRevision &&
          request
            .postDataJSON()
            .content.some((part: { type: string; text?: string }) => part.type === "text" && part.text === "Other tab draft B")
        );
      });
      const extra = other.frameLocator("[data-cloud-panel-frame]");
      const unrelatedSaved =
        width === 1440
          ? other.waitForResponse(
              (response) => response.url() === `${fixture.url}api/ai/conversations/Chat2C/draft` && response.request().method() === "PUT",
            )
          : undefined;
      if (unrelatedSaved) {
        await other.evaluate(() =>
          window.dispatchEvent(
            new CustomEvent("cloud.panel.request", {
              detail: { action: "open", provider: "assistant", search: "conversation=Chat2C", accepted: false },
            }),
          ),
        );
        await extra.locator('a[href="/app/assistant?conversation=Chat2C"]').waitFor();
        await extra.locator('textarea:not([aria-hidden="true"])').fill("Unrelated panel draft");
      }
      await other.locator('textarea:not([aria-hidden="true"])').fill("Other tab draft B");
      if (unrelatedSaved) {
        expect((await unrelatedSaved).ok()).toBe(true);
        // The unrelated acknowledgement arrived while the target write was still held.
        expect(created.draft.revision).toBe(expectedRevision);
        expect(created.draft.content).toEqual([]);
      }
      releaseTarget();
      const response = await saved;
      expect(response.ok()).toBe(true);
      const savedDraft = await response.json();
      expect(savedDraft.content).toEqual([{ type: "text", text: "Other tab draft B" }]);
      expect(savedDraft.revision).toBeGreaterThan(expectedRevision);
      expect(created.draft).toEqual(savedDraft);
      expect(await other.locator('textarea:not([aria-hidden="true"])').inputValue()).toBe("Other tab draft B");
      const revision = savedDraft.revision;
      const writes = fixture.assistant.requests.filter((request) => request.path.endsWith("/draft")).length;
      const replay = page.waitForResponse(
        (response) => response.url() === `${fixture.url}api/ai/conversations` && response.request().method() === "POST",
      );
      await panel.getByRole("button", { name: "Retry creating conversation", exact: true }).click();
      const replayResponse = await replay;
      expect(replayResponse.ok()).toBe(true);
      expect((await replayResponse.json()).draft).toEqual(savedDraft);
      await panel.getByText("The saved draft changed. Your local text has been kept.", { exact: true }).waitFor();
      expect(await composer.inputValue()).toBe("Local draft A");
      await panel.getByText("Other tab draft B", { exact: true }).waitFor();
      expect(created.draft).toMatchObject({ revision, content: [{ type: "text", text: "Other tab draft B" }] });
      expect(fixture.assistant.requests.filter((request) => request.path.endsWith("/draft"))).toHaveLength(writes);
      await page.locator("[data-cloud-panel-close]").click();
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("assistant");
      const creates = fixture.assistant.requests.filter((request) => request.path === "/api/ai/conversations");
      expect(creates).toHaveLength(2);
      expect(creates[1]!.body).toEqual(creates[0]!.body);
      if (width === 390 && process.env.PANEL_SCREENSHOTS) {
        await panel.getByRole("button", { name: "Use saved draft", exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(process.env.PANEL_SCREENSHOTS, "assistant-create-conflict-light-390.png"),
          animations: "disabled",
        });
      }
      await panel.getByRole("button", { name: "Use saved draft", exact: true }).click();
      expect(await composer.inputValue()).toBe("Other tab draft B");
      await page.locator("[data-cloud-panel-close]").click();
      await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
    } catch (error) {
      console.error({
        drafts: [...fixture.assistant.conversations.values()].map(({ id, draft }) => ({ id, draft })),
        requests: fixture.assistant.requests,
      });
      throw error;
    } finally {
      releaseTarget();
      await context.close();
    }
  }, 30_000);
}

for (const width of [1440, 390]) {
  for (const pending of ["create", "save"] as const) {
    test(`Assistant full-view Command Escape restores editing during ${pending} at ${width}px`, async () => {
      fixture.assistant.reset();
      if (pending === "save") fixture.assistant.addConversation("Chat2B", "Command conversation");
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en", timezoneId: "UTC" });
      // The real ShellRuntime reloads once when it first learns the browser timezone.
      // Match the SSR fixture before navigation so that fixture-ready belongs to the tested document.
      await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: fixture.url }]);
      const attachmentDuringCreate = pending === "create" && width === 390;
      const page = await context.newPage();
      let documents = 0;
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
      });
      page.setDefaultTimeout(8_000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let opened = 0;
      await page.route("**/api/capabilities/v1/catalog?*", (route) =>
        route.fulfill({
          json: {
            protocolVersion: 2,
            apps: [
              {
                appId: "chat",
                appName: "Chat",
                appIcon: "ti ti-layout-kanban",
                appDescription: "Tasks",
                manifest: {
                  protocolVersion: 2,
                  appId: "chat",
                  manifestHash: "a".repeat(64),
                  types: [],
                  queries: [],
                  actions: [],
                  commands: [
                    {
                      localId: "task.compose",
                      title: "Create task",
                      description: "Open a task",
                      icon: "ti ti-checkbox",
                      keywords: ["task"],
                      inputSchema: { type: "object", properties: {}, additionalProperties: false },
                      path: "/app/chat",
                    },
                  ],
                },
              },
            ],
            page: { hasMore: false },
          },
        }),
      );
      await page.route("**/api/capabilities/v1/commands/**", async (route) => {
        opened++;
        await route.fulfill({ status: 503, json: { message: "Unexpected command navigation" } });
      });
      await page.route(pending === "create" ? "**/api/ai/conversations" : "**/api/ai/conversations/*/draft", async (route) => {
        if (route.request().method() === (pending === "create" ? "POST" : "PUT")) await gate;
        await route.continue();
      });
      try {
        await page.goto(`${fixture.url}app/assistant${pending === "save" ? "?conversation=Chat2B" : ""}`);
        await page.locator('html[data-fixture-ready="true"]').waitFor();
        if (attachmentDuringCreate)
          await page.evaluate(() => {
            const read = FileReader.prototype.readAsDataURL;
            FileReader.prototype.readAsDataURL = function (file) {
              document.documentElement.dataset.imageReading = "true";
              window.addEventListener("release-command-image", () => read.call(this, file), { once: true });
            };
          });
        const composer = page.locator('textarea:not([aria-hidden="true"])');
        await composer.fill("Plan /");
        await composer.click();
        const command = page.getByRole("option").filter({ hasText: "Create task" });
        await command.waitFor();
        const request = page.waitForRequest(
          (request) =>
            request.url().endsWith(pending === "create" ? "/conversations" : "/draft") &&
            request.method() === (pending === "create" ? "POST" : "PUT"),
        );
        await command.click();
        await request;
        expect(await composer.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(true);
        await composer.press("Escape");
        expect(await composer.isDisabled()).toBe(false);
        expect(await composer.evaluate((element: HTMLTextAreaElement) => element.readOnly)).toBe(false);
        await composer.fill("Later edits after Escape");
        if (attachmentDuringCreate) {
          await page.locator('input[type="file"]').setInputFiles({
            name: "command-image.png",
            mimeType: "image/png",
            buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2hAAAAABJRU5ErkJggg==", "base64"),
          });
          await page.locator('html[data-image-reading="true"]').waitFor();
        }
        expect(await composer.inputValue()).toBe("Later edits after Escape");
        const saved = page.waitForResponse(
          (response) =>
            response.url().endsWith("/draft") &&
            response.request().postData()?.includes("Later edits after Escape") === true &&
            response.ok(),
        );
        release();
        await saved;
        if (attachmentDuringCreate) {
          const savedImage = page.waitForResponse(
            (response) =>
              response.url().endsWith("/draft") &&
              response.request().postData()?.includes("/uploads/command-image.png") === true &&
              response.ok(),
          );
          await composer.evaluate(() => window.dispatchEvent(new Event("release-command-image")));
          await page.getByText("command-image.png", { exact: true }).waitFor();
          await savedImage;
        }

        expect(documents).toBe(1);
        expect(opened).toBe(0);
        expect(fixture.assistant.conversations.size).toBe(1);
        expect(fixture.assistant.submitted()).toBe(0);
        const content = [...fixture.assistant.conversations.values()][0]!.draft.content;
        expect(content).toContainEqual({ type: "text", text: "Later edits after Escape" });
        expect(content.some((part) => part.type === "file" && part.path === "/uploads/command-image.png")).toBe(attachmentDuringCreate);
      } finally {
        release();
        await context.close();
      }
    }, 30_000);
  }
}

for (const historyFailure of [false, true]) {
  test(`Chat protects send preparation while the latest history is pending (failure: ${historyFailure})`, async () => {
    fixture.backend.reset();
    const id = fixture.backend.addChat({
      members: [viewer, nora],
      name: "Older history",
      count: 150,
      unread: 120,
      end: fixture.backend.now(),
    });
    const context = await browser.newContext({ viewport: { width: historyFailure ? 390 : 1440, height: 900 }, locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator(`a[href="/app/chat/panel/c/${id}"]:visible`).click();
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      await page.route(`**/api/chat/conversations/${id}/messages`, async (route) => {
        if (route.request().method() === "GET") {
          await gate;
          if (historyFailure) {
            await route.fulfill({ status: 503, json: { error: "History unavailable" } });
            return;
          }
        }
        await route.continue();
      });
      const reading = page.waitForRequest(
        (request) => request.url().endsWith(`/conversations/${id}/messages`) && request.method() === "GET",
      );
      await panel.locator('textarea:not([aria-hidden="true"])').fill("Send from the older window");
      await panel.getByRole("button", { name: "Send message", exact: true }).click();
      await reading;
      expect(fixture.backend.posted).toHaveLength(0);
      await panel.getByRole("link", { name: "Back to chats", exact: true }).click();
      await panel
        .getByRole("region", { name: "Notifications", exact: true })
        .getByText("Your message is being prepared. Wait before switching chats.", { exact: true })
        .waitFor();
      expect(await panel.locator("html").evaluate(() => location.pathname)).toBe(`/app/chat/panel/c/${id}`);
      await page.locator("[data-cloud-panel-close]").click();
      expect(await page.locator("[data-cloud-panel-frame]").count()).toBe(1);
      await page.locator('[data-cloud-panel-provider="second"]').click();
      expect(await page.locator("#cloud-panel").getAttribute("data-provider")).toBe("chat");
      release();
      if (historyFailure) {
        await page.waitForFunction(
          () =>
            document
              .querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")
              ?.contentDocument?.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])')?.value ===
            "Send from the older window",
        );
        expect(await panel.locator('textarea:not([aria-hidden="true"])').inputValue()).toBe("Send from the older window");
        expect(fixture.backend.posted).toHaveLength(0);
        await page.locator("[data-cloud-panel-close]").click();
        await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
        await page.locator("#open-chat").click();
        await panel.locator('html[data-fixture-ready="true"]').waitFor();
        expect(await panel.locator('textarea:not([aria-hidden="true"])').inputValue()).toBe("Send from the older window");
        return;
      }
      await panel.locator('[data-status="sent"]').filter({ hasText: "Send from the older window" }).waitFor();
      expect(fixture.backend.posted).toHaveLength(1);
      expect(fixture.backend.posted[0]).toMatchObject({ chat: id, body: "Send from the older window" });
      await page.locator("[data-cloud-panel-close]").click();
      await page.locator("[data-cloud-panel-frame]").waitFor({ state: "detached" });
    } finally {
      release();
      await context.close();
    }
  }, 30_000);
}

for (const editDuringSave of [false, true]) {
  test(`Assistant create replay preserves a second local draft in the same workspace (edits during save: ${editDuringSave})`, async () => {
    fixture.assistant.reset();
    const context = await browser.newContext({ viewport: { width: editDuringSave ? 390 : 1440, height: 900 }, locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const writes: { path: string; body: string | null }[] = [];
    page.on("request", (request) => {
      if (["POST", "PUT"].includes(request.method())) writes.push({ path: new URL(request.url()).pathname, body: request.postData() });
    });
    await page.route("**/api/ai/conversations/page?*", (route) =>
      route.fulfill({
        json: {
          items: [...fixture.assistant.conversations.values()],
          total: fixture.assistant.conversations.size,
          page: 1,
          perPage: 20,
          hasNext: false,
        },
      }),
    );
    try {
      await page.goto(fixture.url + "app/fixture");
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      await page.locator("#open-chat").click();
      await page.locator('[data-cloud-panel-provider="assistant"]').click();
      const panel = page.frameLocator("[data-cloud-panel-frame]");
      await panel.locator('html[data-fixture-ready="true"]').waitFor();
      const composer = panel.locator('textarea:not([aria-hidden="true"])');
      await composer.fill("Local creation draft A");
      fixture.assistant.loseCreate();
      await panel.getByRole("button", { name: "Save drafts", exact: true }).click();
      await panel.getByText("Conversation creation is unclear", { exact: true }).waitFor();
      const created = [...fixture.assistant.conversations.values()][0]!;
      await panel.getByRole("button", { name: "Recent and all chats", exact: true }).click();
      await panel.getByRole("dialog").getByText("All chats", { exact: true }).click();
      await panel.locator(`a[href="/app/assistant/panel?conversation=${created.id}"]`).click();
      await page.waitForFunction(
        (id) =>
          new URL(document.querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]")!.contentWindow!.location.href).searchParams.get(
            "conversation",
          ) === id,
        created.id,
      );
      await composer.fill("Second local draft B");
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      context.on("close", () => releaseSave());
      if (editDuringSave) {
        await page.route("**/api/ai/conversations/*/draft", async (route) => {
          if (route.request().method() === "PUT") await saveGate;
          await route.continue();
        });
        const saving = page.waitForRequest((request) => request.url().endsWith("/draft") && request.method() === "PUT");
        await panel.getByRole("button", { name: "Retry creating conversation", exact: true }).click();
        await saving;
        await composer.fill("Later local draft B2");
        await page.locator("[data-cloud-panel-close]").click();
        expect(await page.locator("[data-cloud-panel-frame]").count()).toBe(1);
        releaseSave();
        await panel
          .getByText("Another local draft belongs to this conversation. Save or resolve it before retrying creation.", { exact: true })
          .waitFor();
        expect(await composer.inputValue()).toBe("Later local draft B2");
        expect(created.draft.content).toContainEqual({ type: "text", text: "Second local draft B" });
        await panel.getByRole("button", { name: "Retry creating conversation", exact: true }).click();
      } else {
        await panel.getByRole("button", { name: "Retry creating conversation", exact: true }).click();
      }
      await panel.getByText("The saved draft changed. Your local text has been kept.", { exact: true }).waitFor();
      expect(await composer.inputValue()).toBe("Local creation draft A");
      const otherDraft = editDuringSave ? "Later local draft B2" : "Second local draft B";
      await panel.getByText(otherDraft, { exact: true }).waitFor();
      if (editDuringSave) await page.getByRole("button", { name: "Back to the panel", exact: true }).click();
      await composer.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => {
        const frame = document.querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]");
        const input = frame?.contentDocument?.querySelector<HTMLTextAreaElement>('textarea:not([aria-hidden="true"])');
        if (!frame || !input) return false;
        const bounds = input.getBoundingClientRect();
        const top = frame.getBoundingClientRect().top + bounds.top;
        return bounds.height > 0 && top >= 0 && top + bounds.height <= window.innerHeight;
      });
      const composerBounds = await composer.boundingBox();
      expect(composerBounds && composerBounds.y >= 0 && composerBounds.y + composerBounds.height <= 900).toBe(true);
      if (process.env.PANEL_SCREENSHOTS) {
        mkdirSync(process.env.PANEL_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: resolve(process.env.PANEL_SCREENSHOTS, `assistant-local-conflict-light-${editDuringSave ? 390 : 1440}.png`),
        });
      }
      expect(created.draft.content).toContainEqual({ type: "text", text: otherDraft });
      await page.locator("[data-cloud-panel-close]").click();
      expect(await page.locator("[data-cloud-panel-frame]").count()).toBe(1);
      await panel.getByRole("button", { name: "Use saved draft", exact: true }).click();
      expect(await composer.inputValue()).toBe(otherDraft);
      expect(fixture.assistant.conversations.size).toBe(1);
    } catch (error) {
      console.error({ writes, conversations: [...fixture.assistant.conversations.values()] });
      console.error(await page.frameLocator("[data-cloud-panel-frame]").locator("body").innerText());
      console.error(await page.frameLocator("[data-cloud-panel-frame]").locator('textarea:not([aria-hidden="true"])').inputValue());
      throw error;
    } finally {
      await context.close();
    }
  }, 30_000);
}

const catalog = {
  protocolVersion: 2,
  apps: [
    {
      appId: "notebooks",
      appName: "Notebooks",
      appIcon: "ti ti-notebook",
      appDescription: "Notes",
      manifest: compileCapabilityManifest(
        "notebooks",
        defineCapabilities({
          protocolVersion: 2,
          types: { note: { title: "Note", description: "One note.", reader: "read" } },
          queries: {
            read: {
              title: "Read note",
              description: "Read one note.",
              input: z.object({ id: z.string().describe("Note id.") }).strict(),
              data: z.object({ title: z.string().describe("Title.") }).strict(),
              openWorld: false,
              run: async () => ok({ data: { title: "Synthetic recovery note" } }),
            },
            search: {
              title: "Search notes",
              description: "Find notes.",
              input: UniversalSearchInputSchema,
              data: UniversalSearchDataSchema,
              openWorld: false,
              universalSearch: { tags: [{ tag: "note", title: "Notes", description: "Search notes", aliases: ["notes"] }] },
              run: async () => ok({ data: [] }),
            },
          },
        }),
      ),
    },
  ],
  page: { hasMore: false },
};
for (const { embedded, width } of [
  { embedded: true, width: 1440 },
  { embedded: false, width: 1440 },
  { embedded: false, width: 390 },
])
  test(`catalog and resource recovery in real ${embedded ? "panel" : "fullview"} at ${width}px`, async () => {
    fixture.assistant.reset();
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en", timezoneId: "UTC" });
    await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: fixture.url }]);
    const page = await context.newPage();
    let documents = 0;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    });
    page.setDefaultTimeout(8000);
    let recoveredCatalogLoads = 0;
    let searches = 0;
    let catalogFailed = true;
    let releaseInitial!: () => void;
    let releaseComposer!: () => void;
    const initialCatalog = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const composerCatalog = new Promise<void>((resolve) => {
      releaseComposer = resolve;
    });
    let catalogRequests = 0;
    // A preceding catalog request may fail before the command menu's own request has settled.
    const initialRequested = !embedded ? page.waitForRequest((request) => request.url().includes("/capabilities/v1/catalog")) : undefined;
    await page.route("**/api/capabilities/v1/catalog?*", async (route) => {
      const ordinal = ++catalogRequests;
      if (!embedded) {
        if (ordinal === 1) {
          await initialCatalog;
          return route.fulfill({ status: 503, json: { message: "Synthetic earlier catalog failure" } });
        }
        await composerCatalog;
      }
      if (catalogFailed) return route.fulfill({ status: 503, json: { message: "Synthetic catalog failure" } });
      recoveredCatalogLoads++;
      return route.fulfill({ json: catalog });
    });
    await page.route("**/api/search?*", (route) => {
      searches++;
      if (searches === 1) return route.fulfill({ status: 503, json: { message: "Synthetic search failure" } });
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "start", query: "", apps: [{ id: "notebooks", name: "Notebooks", icon: "ti ti-notebook" }], providers: ["notebooks"] },
          {
            type: "provider",
            provider: "notebooks",
            status: "ok",
            results: [
              {
                appId: "notebooks",
                appName: "Notebooks",
                appIcon: "ti ti-notebook",
                readable: true,
                ref: { type: "notebooks.note", id: "Q3note" },
                title: "Synthetic recovery note",
                href: "/app/notebooks/Q3note",
              },
            ],
            ms: 5,
          },
          { type: "done", status: "complete", count: 1 },
        ]
          .map((line) => JSON.stringify(line) + "\n")
          .join(""),
      });
    });
    try {
      await page.goto(fixture.url + (embedded ? "app/fixture" : "app/assistant"));
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      if (embedded) {
        await page.locator("#open-chat").click();
        await page.locator('[data-cloud-panel-provider="assistant"]').click();
      }
      const view = embedded ? page.frameLocator("[data-cloud-panel-frame]") : page;
      await view.locator('html[data-fixture-ready="true"]').waitFor();
      const composer = view.locator('textarea:not([aria-hidden="true"])');
      if (initialRequested) await initialRequested;
      const failed = page.waitForResponse(
        (response) =>
          response.url().includes("/capabilities/v1/catalog") &&
          response.status() === 503 &&
          (!embedded || new URL(response.request().frame().url()).pathname === "/app/assistant/panel"),
      );
      await composer.fill(embedded ? "/" : "/notes");
      await composer.click();
      releaseInitial();
      await failed;
      await view.getByRole("listbox").waitFor();
      releaseComposer();
      if (embedded) {
        expect(await view.getByText("Commands from apps could not be loaded", { exact: true }).count()).toBe(0);
        catalogFailed = false;
        await composer.press("Escape");
        await composer.fill("plain");
        await composer.fill("/notes");
      } else {
        const retry = view.getByRole("option").filter({ hasText: "Commands from apps could not be loaded" });
        await retry.waitFor();
        catalogFailed = false;
        const recovered = page.waitForResponse(
          (response) =>
            response.url().includes("/capabilities/v1/catalog") &&
            response.status() === 200 &&
            response.request().frame() === page.mainFrame(),
        );
        await retry.click();
        await recovered;
        // A later menu opening also retries a failed catalog: prove this click recovered before reopening.
        await view.getByRole("option", { name: "Notes Choose from Notebooks", exact: true }).waitFor();
        await retry.waitFor({ state: "hidden" });
        expect(recoveredCatalogLoads).toBe(1);
        await composer.press("Escape");
        await composer.fill("plain");
        await composer.fill("/notes");
      }
      const notes = view.getByRole("option", { name: "Notes Choose from Notebooks", exact: true });
      await notes.waitFor();
      expect(recoveredCatalogLoads).toBe(1);
      await notes.click();
      const dialog = view.getByRole("dialog");
      await dialog.waitFor();
      await dialog.locator(".cloud-resource-search__hint").filter({ hasText: "Search is currently unavailable. Try again." }).waitFor();
      await dialog.getByRole("button", { name: "Try again", exact: true }).click();
      await dialog.getByRole("option").filter({ hasText: "Synthetic recovery note" }).click();
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(documents).toBe(1);
      expect(searches).toBe(2);
      expect(await composer.inputValue()).toContain("Synthetic recovery note");
      expect(await view.locator(".k2b-chat-composer__mention").allTextContents()).toEqual(["Synthetic recovery note"]);
      expect(await composer.isEnabled()).toBe(true);
      if (process.env.PANEL_SCREENSHOTS) {
        mkdirSync(process.env.PANEL_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.PANEL_SCREENSHOTS, `resource-recovery-${embedded ? "panel" : "fullview"}.png`) });
      }
    } catch (error) {
      console.error(await (embedded ? page.frameLocator("[data-cloud-panel-frame]") : page).locator("body").innerText());
      throw error;
    } finally {
      releaseInitial();
      releaseComposer();
      await context.close();
    }
  }, 30000);

for (const openFailure of [false, true]) {
  test(`Chat preserves both drafts when Back begins before send (open failure: ${openFailure})`, async () => {
    fixture.backend.reset();
    const older = fixture.backend.addChat({
      members: [viewer, nora],
      name: "Older draft",
      count: 150,
      unread: 120,
      end: fixture.backend.now(),
    });
    const other = fixture.backend.addChat({ members: [viewer, nora], name: "Other draft", count: 3, end: fixture.backend.now() });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    let releaseOpen!: () => void;
    let releaseHistory!: () => void;
    const opening = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const history = new Promise<void>((resolve) => {
      releaseHistory = resolve;
    });
    let historyReads = 0;
    try {
      await page.goto(fixture.url + `app/chat/c/${other}`);
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      const composer = page.locator('textarea:not([aria-hidden="true"])');
      await composer.fill("Other conversation's draft");
      await page.locator(`a[href="/app/chat/c/${older}"]:visible`).click();
      await page.waitForURL(`**/app/chat/c/${older}`);
      await composer.fill("Original conversation's draft");
      await page.route(`**/api/chat/conversations/${other}/snapshot*`, async (route) => {
        await opening;
        if (openFailure) await route.fulfill({ status: 503, json: { error: "Snapshot unavailable" } });
        else await route.continue();
      });
      await page.route(`**/api/chat/conversations/${older}/messages`, async (route) => {
        if (route.request().method() === "GET") {
          historyReads++;
          await history;
          await route.fulfill({ status: 503, json: { error: "History unavailable" } });
        } else await route.continue();
      });
      const requested = page.waitForRequest((request) => request.url().includes(`/conversations/${other}/snapshot`));
      await page.evaluate(() => window.history.back());
      await requested;
      // A real keyboard submit while the previous chat is still on screen must not begin a send.
      await page.keyboard.press("Enter");
      const blocked = await composer.isDisabled();
      const response = page.waitForResponse((result) => result.url().includes(`/conversations/${other}/snapshot`));
      releaseOpen();
      await response;
      releaseHistory();
      await page.getByRole("textbox", { name: "Message to Other draft", exact: true }).waitFor();
      await page.locator('html[data-fixture-ready="true"]').waitFor();
      expect(await composer.inputValue()).toBe("Other conversation's draft");
      await page.locator(`a[href="/app/chat/c/${older}"]:visible`).click();
      await page.waitForURL(`**/app/chat/c/${older}`);
      expect(await composer.inputValue()).toBe("Original conversation's draft");
      expect(blocked).toBe(true);
      expect(historyReads).toBe(0);
      expect(fixture.backend.posted).toHaveLength(0);
      expect(await composer.isEnabled()).toBe(true);
    } finally {
      releaseOpen();
      releaseHistory();
      await context.close();
    }
  }, 30_000);
}
