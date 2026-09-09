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
  const menu = async (name) => {
    await button("Menu").click();
    await p.getByRole("menuitem", { name, exact: true }).click();
  };
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
    const stored = await p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("cloud-login", 2);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const value = await new Promise((resolve) => {
        const r = db.transaction("vault").objectStore("vault").get("header");
        r.onsuccess = () => resolve(r.result);
      });
      db.close();
      return value;
    });
    if (JSON.stringify(stored).includes("012345") || stored.config.methods[0].kdf !== "argon2id-64m-t3-p1")
      throw new Error("Unsafe PIN storage");
    await p.reload();
    if (!(await p.getByRole("dialog").count())) await button("Unlock").click();
    await p.waitForFunction(() => document.activeElement === document.querySelector("dialog .k2b-pin-input input"));
    if (await p.getByRole("dialog").getByRole("button", { name: "Unlock", exact: true }).count())
      throw new Error("Redundant unlock button");
    await pin("111111");
    await p.getByRole("alert").waitFor();
    await p.waitForFunction(() => document.activeElement === document.querySelector("dialog .k2b-pin-input input"));
    await p.waitForFunction(() => !document.querySelector("dialog input[readonly]"));
    if (!(await p.evaluate(() => document.activeElement === document.querySelector("dialog .k2b-pin-input input"))))
      throw new Error("PIN lost focus after retry delay");
    for (const wrong of ["222222", "333333"]) {
      await pin(wrong);
      await p.getByRole("alert").waitFor();
    }
    const deadline = await p.evaluate(() => JSON.parse(localStorage.getItem("pwa-auth.pin-retry")).retryAt);
    await p.reload();
    if (!(await p.getByRole("dialog").count())) await button("Unlock").click();
    if (
      !(await p
        .locator("dialog .k2b-pin-input input")
        .first()
        .evaluate((input) => input.readOnly))
    )
      throw new Error("Reload bypassed PIN delay");
    const restored = await p.evaluate(() => JSON.parse(localStorage.getItem("pwa-auth.pin-retry")));
    if (restored.retryAt !== deadline || restored.attempts !== 3) throw new Error("Reload reset retry state");
    await pin("012345");
    await p.getByRole("status", { name: "Unlocked", exact: true }).waitFor();
    const successWidth = await p.getByRole("dialog").evaluate((dialog) => dialog.getBoundingClientRect().width);
    if (successWidth > 200) throw new Error("Success dialog did not shrink");
    await ready();
    const cleared = await p.evaluate(() => JSON.parse(localStorage.getItem("pwa-auth.pin-retry")));
    if (cleared.attempts || cleared.retryAt) throw new Error("Successful unlock did not reset delay");
    await button("Add Cloud").waitFor();
    await menu("App security");
    await button("Change app PIN").click();
    await pin("012345");
    await p.getByLabel("Repeat PIN", { exact: true }).waitFor();
    await pin("654321");
    await p.getByLabel("Repeat PIN", { exact: true }).fill("654321");
    await button("Save protection").click();
    await ready();
    await menu("Lock app");
    if (!(await p.getByRole("dialog").count())) await button("Unlock").click();
    await pin("012345");
    await p.getByRole("alert").waitFor();
    await pin("654321");
    await ready();
    const other = await context.newPage();
    await other.goto("http://127.0.0.1:4178/");
    if (!(await other.getByRole("dialog").count())) await other.getByRole("button", { name: "Unlock", exact: true }).click();
    await fillAppPin(other, "654321");
    await other.waitForFunction(() => !history.state?.cloudLoginDialog);
    await menu("Lock app");
    await other.getByRole("button", { name: "Unlock", exact: true }).waitFor();
    await other.close();
    await p.screenshot({ path: "output/playwright/pwa-vault-locked.png" });
    if (errors.length) throw new Error(errors.join("\n"));
    return { setup: true, pinChange: true, wrongPin: true, reload: true, crossTabLock: true, errors };
  } finally {
    await context.close();
  }
}
