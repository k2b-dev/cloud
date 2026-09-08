async function _run(page) {
  const fillAppPin = async (target, value) => {
    await target.waitForFunction(() => !document.querySelector("dialog input:disabled, dialog input[readonly]"));
    const digits = target.getByRole("group", { name: "App PIN", exact: true }).locator("input");
    if (await digits.count()) {
      for (let i = 0; i < value.length; i++) await digits.nth(i).fill(value[i]);
    } else await target.getByLabel("App PIN", { exact: true }).fill(value);
  };

  const context = await page.context().browser().newContext({ locale: "en" });
  let p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  try {
    await p.request.post("http://127.0.0.1:4179/__test/reset");
    await p.goto("http://127.0.0.1:4179/");
    await p.getByRole("button", { name: "Continue in browser", exact: true }).click();
    await p.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    await p.getByRole("button", { name: "Add Cloud", exact: true }).click();
    await p.getByRole("button", { name: "Set a six-digit app PIN", exact: true }).click();
    await fillAppPin(p, "012345");
    await p.getByLabel("Repeat app PIN", { exact: true }).fill("012345");
    await p.getByRole("button", { name: "Save protection", exact: true }).click();
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
    await p.getByRole("button", { name: "Close", exact: true }).click();
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    const cache = await p.evaluate(async () => {
      const names = await caches.keys();
      return { names, paths: (await (await caches.open(names[0])).keys()).map((r) => new URL(r.url).pathname) };
    });
    if (cache.paths.some((x) => x.includes("/api/"))) throw new Error("API in shell");
    await context.setOffline(true);
    // Playwright's network interception leaves navigator.onLine true on SW-served reloads.
    await context.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
    await p.reload().catch((error) => {
      // WebKit automation can report an internal navigation error after the SW has rendered the offline document.
      if (context.browser().browserType().name() !== "webkit" || !String(error).includes("WebKit encountered an internal error"))
        throw error;
    });
    await p.getByText("You are offline. Connect to the internet to pair or approve sign-ins.", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Unlock", exact: true }).click();
    await fillAppPin(p, "012345");
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    await p.getByRole("button", { name: "Add Cloud", exact: true }).waitFor();
    if ((await p.evaluate(() => document.body.dataset.testVersion)) !== "1") throw new Error("Offline shell absent");
    await context.setOffline(false);
    await p.request.post("http://127.0.0.1:4179/__test/next");
    await p.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      await r.update();
    });
    await p.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
    if ((await p.evaluate(() => document.body.dataset.testVersion)) !== "1") throw new Error("Update replaced live document");
    await p.reload();
    if ((await p.evaluate(() => document.body.dataset.testVersion)) !== "1") throw new Error("Waiting update replaced active shell");
    await p.close();
    // With no controlled clients left the browser may activate the waiting worker.
    await page.waitForTimeout(1000);
    p = await context.newPage();
    await p.goto("http://127.0.0.1:4179/");
    await p.waitForFunction(() => document.body.dataset.testVersion === "2");
    const after = await p.evaluate(async () => await caches.keys());
    if (after.length !== 1 || !after[0].endsWith("test2")) throw new Error("Old shell cache retained " + after);
    return {
      offlinePinUnlock: true,
      offlineStart: true,
      noCachedApi: true,
      updateWaits: true,
      newVersionAfterClose: true,
      assets: cache.paths.length,
    };
  } catch (error) {
    throw new Error(
      String(error) +
        JSON.stringify({
          errors,
          state: await p
            .evaluate(() => ({ online: navigator.onLine, body: document.body.innerText, url: location.href }))
            .catch(() => null),
        }),
    );
  } finally {
    await context.close();
  }
}
