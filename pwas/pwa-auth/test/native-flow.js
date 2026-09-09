async function _run(page) {
  const context = await page
    .context()
    .browser()
    .newContext({ locale: "en", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await context.newPage();
  try {
    await p.goto("http://127.0.0.1:4178/");
    await p.getByRole("button", { name: "Continue in browser", exact: true }).click();
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    const buttons = await p.evaluate(() =>
      [...document.querySelectorAll("button")]
        .filter((b) => b.getBoundingClientRect().width)
        .map((b) => ({ text: b.textContent, height: b.getBoundingClientRect().height })),
    );
    if (buttons.some((b) => b.height < 44)) throw new Error("Small touch target " + JSON.stringify(buttons));
    await p.screenshot({ path: "output/playwright/pwa-native-home.png" });
    await p.getByRole("button", { name: "Add Cloud", exact: true }).click();
    await p.getByRole("button", { name: "Set a six-digit app PIN", exact: true }).click();
    await p.getByLabel("App PIN", { exact: true }).fill("012345");
    await p.getByLabel("Repeat PIN", { exact: true }).fill("012345");
    await p.getByRole("button", { name: "Save protection", exact: true }).click();
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
    const input = await p
      .getByRole("dialog")
      .locator("input")
      .evaluate((i) => ({ font: getComputedStyle(i).fontSize, height: i.getBoundingClientRect().height }));
    if (input.font !== "16px" || input.height < 44) throw new Error("Small input " + JSON.stringify(input));
    await p.screenshot({ path: "output/playwright/pwa-native-pairing.png" });
    await p.goBack();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    if (p.url() !== "http://127.0.0.1:4178/") throw new Error("Back left app");
    await p.getByRole("button", { name: "Add Cloud", exact: true }).click();
    await p.getByRole("button", { name: "Close", exact: true }).click();
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    await p.getByRole("button", { name: "Menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await p.getByRole("dialog").getByText("Dark", { exact: true }).click();
    await p.getByRole("button", { name: "Done", exact: true }).click();
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    await context.route("**/assets/*.js", (r) => r.abort());
    await p.reload();
    const earlyTheme = await p.evaluate(() => ({
      theme: document.body.dataset.theme,
      background: getComputedStyle(document.body).backgroundColor,
    }));
    if (earlyTheme.theme !== "dark") throw new Error("Dark theme depended on app JS");
    return { buttons, input, back: true, close: true, earlyTheme };
  } finally {
    await context.close();
  }
}
