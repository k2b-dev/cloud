async function _run(page) {
  const context = await page
    .context()
    .browser()
    .newContext({ locale: "en", viewport: { width: 390, height: 844 } });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (error) => errors.push(error.message));
  const button = (name) => p.getByRole("button", { name, exact: true });
  const ready = () => p.waitForFunction(() => !history.state?.k2bDialog);
  try {
    await p.goto("http://127.0.0.1:4178/");
    await button("Continue in browser").click();
    await ready();
    await button("Add Cloud").click();
    await p.getByLabel("Pairing link", { exact: true }).waitFor();
    if (await p.locator(".k2b-pin-input").count()) throw new Error("Pairing asked for a PIN");
    await button("Close").click();
    await ready();
    await p.reload();
    await button("Add Cloud").waitFor();
    await p.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await p.waitForTimeout(100);
    if (await p.getByRole("dialog").count()) throw new Error("Local vault prompted on return");
    await button("Menu").click();
    if (await p.getByRole("menuitem", { name: /App security|Lock app/ }).count()) throw new Error("PIN controls remain");
    if (errors.length) throw new Error(errors.join("\n"));
    return { directPairing: true, reloadOpens: true, returnOpens: true, noPinControls: true };
  } finally {
    await context.close();
  }
}
