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
  test(`message editing, failed retry, deletion and cancellation at ${width}px`, async () => {
    harness.reset();
    const chat = harness.addChat({ members: [viewer, nora], name: "Planning", count: 0, end: chatTestNow });
    harness.receive(chat, viewer, "The meeting starts at nine.");
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(pinPageClock, chatTestNow.getTime());
    const page = await context.newPage();
    const errors = pageErrors(page);
    page.setDefaultTimeout(5_000);
    try {
      await page.goto(new URL(`/app/chat/c/${chat}`, harness.url).href);
      await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props({ chat }) });
      const shot = async (state: string) => {
        if (!process.env.CHAT_MUTATION_SHOTS) return;
        await mkdir(process.env.CHAT_MUTATION_SHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.CHAT_MUTATION_SHOTS}/${state}-light-${width}.png` });
      };
      const row = () => page.locator(".k2b-message-row", { hasText: "The meeting starts" });
      const menu = async () => {
        await row().hover();
        await row().getByRole("button", { name: "Message actions", exact: true }).click();
      };
      await shot("01-original");
      await menu();
      await page.getByRole("menuitem", { name: "Edit message", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const field = dialog.getByRole("textbox", { name: "Message", exact: true });
      await field.fill("The meeting starts at ten.");
      harness.failMutations();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.getByRole("alert").waitFor();
      await page.waitForFunction(() => {
        const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) =>
          button.textContent?.includes("Try again"),
        );
        return retry && !retry.disabled;
      });
      expect(await field.inputValue()).toBe("The meeting starts at ten.");
      await shot("02-failed-edit");
      await dialog.getByRole("button", { name: "Try again", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await row().waitFor();
      await row().locator(".k2b-message-row__edited").waitFor();
      await shot("03-edited");
      await menu();
      await page.getByRole("menuitem", { name: "Delete message", exact: true }).click();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await row().count()).toBe(1);
      await menu();
      await page.getByRole("menuitem", { name: "Delete message", exact: true }).click();
      await dialog.getByRole("button", { name: "Delete message", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.locator(".k2b-message-row [data-deleted]").waitFor();
      expect(await page.getByText("The meeting starts at ten.", { exact: true }).count()).toBe(0);
      await shot("04-deleted");
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(new URL(`/app/chat/c/${chat}?theme=dark`, harness.url).href);
      await page.evaluate(({ props }) => window.mountChat(props, "en"), { props: harness.props({ chat }) });
      await page.locator(".k2b-message-row [data-deleted]").waitFor();
      if (process.env.CHAT_MUTATION_SHOTS)
        await page.screenshot({ path: `${process.env.CHAT_MUTATION_SHOTS}/04-deleted-dark-${width}.png` });
      expect(await page.locator(".k2b-message-row [data-deleted]").isVisible()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
