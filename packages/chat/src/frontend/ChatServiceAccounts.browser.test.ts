import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Browser, BrowserContext } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { chatMessages } from "../messages";
import { MemberPageSchema, MemberSchema } from "../service/contracts";
import { chatTestNow, nora, pinPageClock, startChatHarness, viewer } from "./ChatWorkspace.browser-fixture";

let harness: Awaited<ReturnType<typeof startChatHarness>>;
let browser: Browser;
let context: BrowserContext | undefined;
beforeAll(async () => {
  harness = await startChatHarness();
  browser = await launchBrowser();
}, 60_000);
afterEach(async () => {
  await context?.close();
  context = undefined;
  harness.reset();
});
afterAll(async () => {
  await browser?.close();
  harness?.stop();
});

for (const mode of [
  { width: 1440, locale: "en" },
  { width: 390, locale: "de" },
]) {
  describe(`service-account info ${mode.width}`, () => {
    test("pick an agent for a new chat, add a service account and change its role", async () => {
      context = await browser.newContext({
        viewport: { width: mode.width, height: 900 },
        isMobile: mode.width === 390,
        hasTouch: mode.width === 390,
      });
      const page = await context.newPage();
      await page.addInitScript(pinPageClock, chatTestNow.getTime());
      const t = chatMessages.resolve([mode.locale]).t;
      const agent = { id: "44444444-4444-4444-8444-444444444444", name: "Atlas Agent", kind: "agent" as const };
      const account = { id: "55555555-5555-4555-8555-555555555555", name: "Studio Service", kind: "standalone" as const };
      harness.addServiceAccount(agent);
      harness.addServiceAccount(account);
      await page.goto(harness.url);
      await page.evaluate(async (locale) => window.mountChat(await (await fetch("/__props")).json(), locale), mode.locale);
      await page.getByRole("button", { name: t.newChat, exact: true }).filter({ visible: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox").fill("Atlas");
      await page.getByRole("option").filter({ hasText: agent.name }).click();
      await dialog.locator(".chat-member-row").getByText(t.agentAccount, { exact: true }).waitFor();
      expect(await dialog.locator(".chat-member-row .ti-robot").count()).toBe(1);
      await dialog.getByRole("textbox", { name: t.name, exact: true }).fill("Studio team");
      await dialog.getByRole("button", { name: t.startChat, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByRole("link", { name: t.chatInfo, exact: true }).filter({ visible: true }).click();
      const info = page.locator("#k2b-workspace-detail-chat-info");
      await info.locator(".chat-member-row").filter({ hasText: agent.name }).getByText(t.agentAccount, { exact: true }).waitFor();
      await info.getByRole("button", { name: t.addPeople, exact: true }).click();
      await dialog.getByRole("combobox").fill("Studio");
      await page.getByRole("option").filter({ hasText: account.name }).click();
      await dialog.locator(".chat-member-row").getByText(t.standaloneAccount, { exact: true }).waitFor();
      await dialog.getByRole("button", { name: t.add, exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      const row = info.locator(".chat-member-row").filter({ hasText: account.name });
      await row.getByText(t.standaloneAccount, { exact: true }).waitFor();
      const role = row.getByRole("button", { name: t.permissionFor({ name: account.name }), exact: true });
      await role.click();
      await page
        .getByRole("menuitemradio")
        .filter({ has: page.getByText(t.permissionRead, { exact: true }) })
        .click();
      await role.getByText(t.permissionRead, { exact: true }).waitFor();
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      expect(harness.members(id).find((entry) => entry.displayName === account.name)?.permission).toBe("read");
    });
    test("the pickers offer only accounts this chat can accept", async () => {
      context = await browser.newContext({
        viewport: { width: mode.width, height: 900 },
        isMobile: mode.width === 390,
        hasTouch: mode.width === 390,
      });
      const page = await context.newPage();
      await page.addInitScript(pinPageClock, chatTestNow.getTime());
      const t = chatMessages.resolve([mode.locale]).t;
      const chat = harness.addChat({ members: [viewer, nora], name: "Ops", count: 1, end: chatTestNow });
      const accounts = [
        { id: "a1111111-1111-4111-8111-111111111111", name: "Bot standalone", kind: "standalone" as const },
        { id: "a2222222-2222-4222-8222-222222222222", name: "Bot disabled", kind: "agent" as const, status: "disabled" as const },
        { id: "a3333333-3333-4333-8333-333333333333", name: "Bot personal key", kind: "user_delegated" as const },
        {
          id: "a4444444-4444-4444-8444-444444444444",
          name: "Bot bound here",
          kind: "resource_bound" as const,
          binding: `chat:conversation:${chat}`,
        },
        {
          id: "a5555555-5555-4555-8555-555555555555",
          name: "Bot bound elsewhere",
          kind: "resource_bound" as const,
          binding: "chat:conversation:Other01",
        },
      ];
      for (const account of accounts) harness.addServiceAccount(account);
      await page.goto(new URL(`/app/chat/c/${chat}`, harness.url).href);
      await page.evaluate(
        async ({ chat, locale }) =>
          window.mountChat(await (await fetch(`/__props?path=${encodeURIComponent(`/app/chat/c/${chat}`)}`)).json(), locale),
        { chat, locale: mode.locale },
      );
      await page.getByRole("link", { name: t.chatInfo, exact: true }).filter({ visible: true }).click();
      await page.locator("#k2b-workspace-detail-chat-info").getByRole("button", { name: t.addPeople, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox").fill("Bot");
      await page.getByRole("option").first().waitFor();
      expect((await page.getByRole("option").allInnerTexts()).map((text) => text.split("\n")[0])).toEqual([
        "Bot standalone",
        "Bot bound here",
      ]);
    });
    for (const kind of ["agent", "standalone"] as const) {
      for (const managers of [1, 2]) {
        test(`${kind} keeps its avatar, kind and manager guard with ${managers} managers`, async () => {
          context = await browser.newContext({ viewport: { width: mode.width, height: 900 } });
          const page = await context.newPage();
          await page.addInitScript(pinPageClock, chatTestNow.getTime());
          const id = harness.addChat({ name: "Planning", members: [viewer, nora], count: 1, end: harness.now() });
          const member = MemberSchema.parse({
            ...harness.members(id)[0],
            principal: { type: "service_account", serviceAccountId: "44444444-4444-4444-8444-444444444444" },
            displayName: "Atlas Example",
            serviceAccountKind: kind,
            permission: "admin",
          });
          // The server's manager count includes entries outside this visible page.
          // Its grant and scope semantics are exercised by the API integration suite.
          await page.route(
            (url) => url.pathname === `/api/chat/conversations/${id}/members`,
            (route) =>
              route.fulfill({
                json: MemberPageSchema.parse({ items: [member], managers, self: null, nextCursor: null }),
              }),
          );
          const path = `/app/chat/c/${id}?panel=info`;
          await page.goto(new URL(path, harness.url).href);
          await page.evaluate(
            async ({ path, locale }) => {
              window.mountChat(await (await fetch(`/__props?path=${encodeURIComponent(path)}`)).json(), locale);
            },
            { path, locale: mode.locale },
          );
          const t = chatMessages.resolve([mode.locale]).t;
          const panel = page.locator("#k2b-workspace-detail-chat-info");
          const row = panel.locator(".chat-member-row").filter({ hasText: "Atlas Example" });
          await row.getByText(kind === "agent" ? t.agentAccount : t.standaloneAccount, { exact: true }).waitFor();
          expect(await row.locator(".ti-robot").count()).toBe(1);
          expect(await row.locator("img").count()).toBe(0);
          await settled(page);
          const bounds = await row.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mode.width);
          const remove = row.getByRole("button", { name: t.removeName({ name: member.displayName }), exact: true });
          expect(await remove.isDisabled()).toBe(managers === 1);
          expect(await remove.getAttribute("aria-description")).toBe(managers === 1 ? t.lastManager : null);
          await row.getByRole("button", { name: t.permissionFor({ name: member.displayName }), exact: true }).click();
          for (const label of [t.permissionRead, t.permissionWrite]) {
            const option = page.getByRole("menuitemradio").filter({ has: page.getByText(label, { exact: true }) });
            await option.waitFor();
            expect(await option.isDisabled()).toBe(managers === 1);
          }
          expect(
            await page
              .getByRole("menuitemradio")
              .filter({ has: page.getByText(t.permissionManage, { exact: true }) })
              .isDisabled(),
          ).toBe(false);
        });
      }
    }
  });
}
