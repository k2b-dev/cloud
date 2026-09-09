async function _run(page) {
  const fillAppPin = async (target, value) => {
    await target.waitForFunction(() => !document.querySelector("dialog input:disabled, dialog input[readonly]"));
    const digits = target.getByRole("group", { name: "App PIN", exact: true }).locator("input");
    if (await digits.count()) {
      for (let i = 0; i < value.length; i++) await digits.nth(i).fill(value[i]);
    } else await target.getByLabel("App PIN", { exact: true }).fill(value);
  };

  const context = await page
    .context()
    .browser()
    .newContext({ locale: "en", viewport: { width: 390, height: 844 } });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const button = (name) => p.getByRole("button", { name, exact: true });
  const pin = async (value) => fillAppPin(p, value);
  const ready = async () => p.waitForFunction(() => !history.state?.cloudLoginDialog);
  try {
    await p.goto("http://127.0.0.1:4178/");
    await button("Continue in browser").click();
    await ready();
    await button("Add Cloud").click();
    await p.getByRole("heading", { name: "Protect Cloud Login" }).waitFor();
    await button("Set a six-digit app PIN").click();
    await p.waitForFunction(() => document.activeElement === document.querySelector("dialog input"));
    await pin("012345");
    await p.getByLabel("Repeat PIN", { exact: true }).fill("012346");
    if (!(await button("Save protection").isDisabled())) throw new Error("Mismatched PIN accepted");
    await p.getByLabel("Repeat PIN", { exact: true }).fill("012345");
    await button("Save protection").click();
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
    await button("Close").click();
    await ready();
    await p.reload();
    await p.getByRole("dialog").waitFor();
    await p.waitForFunction(() => document.activeElement === document.querySelector("dialog .k2b-pin-input input"));
    await p.evaluate(() => {
      document.querySelector("dialog").focus();
      window.dispatchEvent(new Event("focus"));
    });
    await p.waitForFunction(() => document.activeElement === document.querySelector("dialog .k2b-pin-input input"));
    await p.locator("dialog .k2b-pin-input input").nth(2).focus();
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.waitForTimeout(50);
    if (
      !(await p
        .locator("dialog .k2b-pin-input input")
        .nth(2)
        .evaluate((el) => el === document.activeElement))
    )
      throw new Error("Activation reset the current PIN digit");
    await button("Close").click();
    await ready();
    await p.waitForTimeout(250);
    if (await p.getByRole("dialog").count()) throw new Error("Dismissed unlock reopened");
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.getByRole("dialog").waitFor();
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    if ((await p.getByRole("dialog").count()) !== 1) throw new Error("Duplicate unlock dialogs");
    await pin("012345");
    await ready();
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    if (await p.getByRole("dialog").count()) throw new Error("Open vault prompted again");
    if (errors.length) throw new Error(errors.join("\n"));
    return { autoOpen: true, focused: true, dismissal: true, focusReturn: true, noDuplicates: true };
  } finally {
    await context.close();
  }
}
