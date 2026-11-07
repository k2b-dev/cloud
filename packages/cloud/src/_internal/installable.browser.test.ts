import { expect, test } from "bun:test";
import { launchBrowser } from "../../../ui/test/browser";
import { kiosk } from "./installable.test-fixture";
import { installableWorker } from "./installable-assets";

test("two scoped workers keep private pages online, show only neutral offline content, and wait for the old window to close before updating", async () => {
  let revision = 1;
  const declarations = [kiosk, { ...kiosk, path: "/app/orders/counter/", name: "Orders counter" }];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const app = declarations.find((entry) => url.pathname.startsWith(entry.path));
      if (app && url.pathname === `${app.path}sw.js`)
        return new Response(installableWorker(app) + `\n// revision ${revision}`, {
          headers: { "Content-Type": "text/javascript", "Cache-Control": "no-store" },
        });
      if (url.pathname.startsWith("/api/")) return new Response("private API");
      return new Response("<!doctype html><title>Private online page</title><main>private customer document</main>", {
        headers: { "Content-Type": "text/html", "Cache-Control": "private, no-store" },
      });
    },
  });
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext();
    const first = await context.newPage();
    const second = await context.newPage();
    for (const [index, page] of [first, second].entries()) {
      const scope = declarations[index]!.path;
      await page.goto(server.url.origin + scope);
      await page.evaluate(async (scope) => {
        const registration = await navigator.serviceWorker.register(`${scope}sw.js`, { scope, updateViaCache: "none" });
        await navigator.serviceWorker.ready;
        if (!registration.active) throw new Error("Worker not active");
      }, scope);
      await page.reload();
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    }
    expect(
      await first.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map((entry) => new URL(entry.scope).pathname).sort(),
      ),
    ).toEqual(declarations.map((entry) => entry.path).sort());
    // A private online response is never retained for an offline revisit.
    await first.goto(server.url.origin + kiosk.path + "documents/private");
    expect(await first.locator("main").textContent()).toBe("private customer document");
    await context.setOffline(true);
    await first.goto(server.url.origin + kiosk.path + "documents/private");
    expect(await first.locator("main").textContent()).not.toContain("private customer document");
    expect(await first.locator("main").textContent()).toContain("You're offline");
    expect(await first.evaluate(() => caches.keys())).toEqual([]);
    expect(
      await first.evaluate(async () => {
        try {
          await fetch("/api/inventory/private");
          return "unexpected response";
        } catch {
          return "network failure";
        }
      }),
    ).toBe("network failure");
    await context.setOffline(false);
    await first.getByRole("button", { name: "Try again / Erneut versuchen" }).click();
    await first.waitForFunction(() => document.title === "Private online page");
    await first.evaluate(() => {
      document.body.dataset.controllerChanges = "0";
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        document.body.dataset.controllerChanges = String(Number(document.body.dataset.controllerChanges) + 1);
      });
    });
    revision = 2;
    await first.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await first.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === "installed");
    expect(await first.locator("body").getAttribute("data-controller-changes")).toBe("0");
    expect(await first.title()).toBe("Private online page");
    await first.close();
    // An unrelated PWA window must not prevent this registration from activating.
    await second.waitForFunction(async (scope) => {
      const registration = await navigator.serviceWorker.getRegistration(scope);
      return !!registration?.active && !registration.waiting && !registration.installing;
    }, kiosk.path);
    const restarted = await context.newPage();
    await restarted.goto(server.url.origin + kiosk.path);
    await restarted.waitForFunction(() => !!navigator.serviceWorker.controller);
    expect(await restarted.evaluate(() => caches.keys())).toEqual([]);
    await context.close();
  } finally {
    await browser?.close();
    await server.stop(true);
  }
}, 60_000);
