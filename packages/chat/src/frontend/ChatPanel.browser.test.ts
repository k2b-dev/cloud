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
      await panel.getByRole("button", { name: provider === "chat" ? "Try again" : "Save drafts", exact: true }).waitFor();
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
      } else
        await context.addInitScript(() => {
          const read = FileReader.prototype.readAsDataURL;
          FileReader.prototype.readAsDataURL = function (file) {
            document.documentElement.dataset.imageReading = "true";
            window.addEventListener(
              "release-image",
              () => {
                read.call(this, file);
              },
              { once: true },
            );
          };
        });
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
        if (preparation === "image") await composer.evaluate(() => window.dispatchEvent(new Event("release-image")));
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
