async function _run(page) {
  const results = [];
  for (const [locale, colorScheme] of [
    ["en", "light"],
    ["de", "dark"],
  ]) {
    const context = await page
      .context()
      .browser()
      .newContext({ locale, colorScheme, viewport: { width: 390, height: 844 } });
    const p = await context.newPage();
    try {
      await p.goto("http://127.0.0.1:4178/");
      await p.getByRole("button", { name: locale === "de" ? "Im Browser fortfahren" : "Continue in browser", exact: true }).click();
      await p.getByRole("button", { name: locale === "de" ? "Cloud hinzufügen" : "Add Cloud", exact: true }).click();
      await p
        .getByRole("button", { name: locale === "de" ? "Sechsstellige App-PIN einrichten" : "Set a six-digit app PIN", exact: true })
        .click();
      await p.getByLabel(locale === "de" ? "App-PIN" : "App PIN", { exact: true }).fill("012345");
      await p.getByLabel(locale === "de" ? "App-PIN wiederholen" : "Repeat app PIN", { exact: true }).fill("012345");
      await p.getByRole("button", { name: locale === "de" ? "Schutz speichern" : "Save protection", exact: true }).click();
      await p.getByRole("heading", { name: locale === "de" ? "Cloud hinzufügen" : "Add Cloud", exact: true }).waitFor();
      const d = p.getByRole("dialog");
      const next = p.getByRole("button", { name: locale === "de" ? "Weiter" : "Continue", exact: true });
      if (!(await next.isDisabled())) throw new Error("Empty link accepted");
      const style = await d.evaluate((dialog) => {
        const actions = dialog.querySelector(".auth-dialog-actions");
        const first = actions.children[0].getBoundingClientRect(),
          last = actions.children[1].getBoundingClientRect();
        const text = dialog.querySelector(".auth-flow p");
        return {
          family: getComputedStyle(text).fontFamily,
          size: getComputedStyle(text).fontSize,
          expectedSize: parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.875 + "px",
          right: last.left > first.right,
          footer: actions.closest("footer") !== null,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      if (!style.right || !style.footer || style.overflow || style.size !== style.expectedSize)
        throw new Error("Dialog layout regression: " + JSON.stringify(style));
      await p.screenshot({ path: `output/playwright/pwa-pairing-${locale}.png`, fullPage: true });
      await p.getByRole("dialog").locator("input").fill("https://invalid.example/#pairing=bad");
      await next.click();
      await p.getByRole("alert").waitFor();
      await p.keyboard.press("Escape");
      await d.waitFor({ state: "hidden" });
      const trigger = p.getByRole("button", { name: locale === "de" ? "Menü" : "Menu", exact: true });
      await trigger.click();
      const triggerBox = await trigger.boundingBox();
      const menuBox = await p.getByRole("menu").boundingBox();
      if (Math.abs(triggerBox.x + triggerBox.width - menuBox.x - menuBox.width) > 1) throw new Error("Menu is not end aligned");
      await p.keyboard.press("Escape");
      await trigger.click();
      await p.getByRole("menuitem", { name: locale === "de" ? "Erscheinungsbild" : "Appearance", exact: true }).click();
      const colors = [];
      for (const [choice, label] of [
        ["dark", locale === "de" ? "Dunkel" : "Dark"],
        ["light", locale === "de" ? "Hell" : "Light"],
      ]) {
        await d.getByText(label, { exact: true }).click();
        const state = await p.evaluate(() => ({
          theme: document.body.dataset.theme,
          colorScheme: getComputedStyle(document.body).colorScheme,
          background: getComputedStyle(document.body).backgroundColor,
          surface: getComputedStyle(document.querySelector("dialog")).getPropertyValue("--k2b-surface"),
          meta: document.querySelector('meta[name="theme-color"]').content,
        }));
        if (state.theme !== choice || state.colorScheme !== choice || state.meta !== state.background)
          throw new Error("Theme not applied: " + JSON.stringify(state));
        colors.push(state.surface);
      }
      if (colors[0] === colors[1]) throw new Error("Dialog colors did not change");
      await d.getByText(locale === "de" ? "Dunkel" : "Dark", { exact: true }).click();
      await p.reload();
      if ((await p.evaluate(() => document.body.dataset.theme)) !== "dark") throw new Error("Theme not persisted");
      results.push({ locale, colorScheme, menuEndAligned: true, themeSwitchAndReload: true, ...style });
    } finally {
      await context.close();
    }
  }
  return results;
}
