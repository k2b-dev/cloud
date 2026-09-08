async function _run(page) {
  const context = await page.context().browser().newContext({ locale: "en" });
  let p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  try {
    await p.request.post("http://127.0.0.1:4179/__test/reset");
    await p.goto("http://127.0.0.1:4179/");
    await p.getByRole("button", { name: "Continue in browser", exact: true }).click();
    await p.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const cache = await p.evaluate(async () => {
      const names = await caches.keys();
      return { names, paths: (await (await caches.open(names[0])).keys()).map((r) => new URL(r.url).pathname) };
    });
    if (cache.paths.some((x) => x.includes("/api/"))) throw new Error("API in shell");
    await context.setOffline(true);
    // Playwright's network interception leaves navigator.onLine true on SW-served reloads.
    await context.addInitScript(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
    await p.reload();
    await p.getByText("You are offline. Connect to the internet to pair or approve sign-ins.", { exact: true }).waitFor();
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
    return { offlineStart: true, noCachedApi: true, updateWaits: true, newVersionAfterClose: true, assets: cache.paths.length };
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
