import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { chatTestNow, nora, pinPageClock, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let browser: Browser;
beforeAll(async () => {
  harness = await startChatHarness();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  harness?.stop();
});

for (const width of [1440, 390])
  for (const theme of ["light", "dark"] as const)
    test(`message provenance at ${width}px in ${theme}`, async () => {
      harness.reset();
      const chat = harness.addChat({ members: [viewer, nora], name: "Planning", count: 0, end: chatTestNow });
      harness.receive(chat, nora, "The delivery is confirmed.", "assistant");
      harness.receive(chat, nora, "I will meet the delivery.");
      harness.receive(chat, viewer, "Please use the courtyard entrance.", "mcp");
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
      await context.addInitScript(pinPageClock, chatTestNow.getTime());
      const page = await context.newPage();
      const errors = pageErrors(page);
      page.setDefaultTimeout(5_000);
      try {
        await page.goto(new URL(`/app/chat/c/${chat}?theme=${theme}`, harness.url).href);
        await page.evaluate(({ props }) => window.mountChat(props, "de"), { props: harness.props({ chat }) });
        const assistant = page.locator(".k2b-message-row", { hasText: "The delivery is confirmed." });
        const direct = page.locator(".k2b-message-row", { hasText: "I will meet the delivery." });
        const own = page.locator(".k2b-message-row", { hasText: "Please use the courtyard entrance." });
        await assistant.getByText("über Assistant", { exact: true }).waitFor();
        await own.getByText("über MCP", { exact: true }).waitFor();
        expect(await direct.locator(".k2b-message-row__badge").count()).toBe(0);
        expect(await direct.getAttribute("data-group-start")).not.toBeNull();
        expect(await own.getAttribute("data-own")).not.toBeNull();
        if (process.env.CHAT_PROVENANCE_SHOTS) {
          await mkdir(process.env.CHAT_PROVENANCE_SHOTS, { recursive: true });
          await page.screenshot({ path: `${process.env.CHAT_PROVENANCE_SHOTS}/provenance-${theme}-${width}.png` });
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

// Direct outbox messages omit via; server projections carry null. Both must keep the same grouping.
test("two direct own messages keep their group while the second send is pending", async () => {
  harness.reset();
  const chat = harness.addChat({ members: [viewer, nora], count: 0, end: chatTestNow });
  harness.receive(chat, viewer, "First direct message.");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(pinPageClock, chatTestNow.getTime() + 60_000);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(new URL(`/app/chat/c/${chat}`, harness.url).href);
    await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props({ chat }) });
    await page.route(`**/api/chat/conversations/${chat}/messages`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await held;
      await route.continue();
    });
    await page.getByRole("textbox").fill("Second direct message.");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    const row = page.locator(".k2b-message-row", { hasText: "Second direct message." });
    await page.locator('[data-status="pending"]').waitFor();
    expect(await row.getAttribute("data-group-start")).toBeNull();
    release?.();
    await page.locator('[data-status="pending"]').waitFor({ state: "detached" });
    expect(await row.getAttribute("data-group-start")).toBeNull();
  } finally {
    release?.();
    await context.close();
  }
});
