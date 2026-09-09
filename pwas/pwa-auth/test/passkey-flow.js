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
  await context.addInitScript(() => {
    window.__vaultTrace = [];
    for (const operation of ["create", "get"]) {
      const original = navigator.credentials[operation].bind(navigator.credentials);
      navigator.credentials[operation] = async (options) => {
        try {
          const value = await original(options);
          const prf = value?.getClientExtensionResults().prf;
          window.__vaultTrace.push({ operation, enabled: prf?.enabled, bytes: prf?.results?.first?.byteLength });
          return value;
        } catch (error) {
          window.__vaultTrace.push({ operation, error: error.name });
          throw error;
        }
      };
    }
  });
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  const button = (name) => p.getByRole("button", { name, exact: true });
  const menu = async (name) => {
    await button("Menu").click();
    await p.getByRole("menuitem", { name, exact: true }).click();
  };
  const ready = async () => p.waitForFunction(() => !history.state?.cloudLoginDialog);
  try {
    await p.goto("http://localhost:4178/");
    const intro = button("Continue in browser");
    if (await intro.isVisible()) {
      await intro.click();
      await ready();
    }
    await button("Add Cloud").click();
    const cta = button("Set up passkey");
    if (!(await cta.evaluate((button) => !!button.closest("footer")))) throw new Error("Passkey CTA outside footer");
    const alternative = button("Set a six-digit app PIN");
    if (!(await alternative.evaluate((button) => button.dataset.variant === "text" || button.classList.contains("k2b-button--text"))))
      throw new Error("PIN is not a text alternative");
    await p.screenshot({ path: "output/playwright/pwa-passkey-setup.png" });
    await cta.click();
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor({ timeout: 15000 });
    await button("Close").click();
    await ready();
    await p.reload();
    if (!(await p.getByRole("dialog").count())) await button("Unlock").click();
    if (await button("Use passkey instead").isVisible()) await button("Use passkey instead").click();
    await button("Unlock with passkey").click();
    await ready();
    await menu("App security");
    await button("Set a six-digit app PIN").click();
    if (await button("Use passkey instead").isVisible()) await button("Use passkey instead").click();
    await button("Unlock with passkey").click();
    await fillAppPin(p, "012345");
    await p.getByLabel("Repeat PIN", { exact: true }).fill("012345");
    await button("Save protection").click();
    await ready();
    await menu("Lock app");
    if (!(await p.getByRole("dialog").count())) await button("Unlock").click();
    await fillAppPin(p, "012");
    await button("Use passkey instead").click();
    if (await p.getByRole("group", { name: "App PIN", exact: true }).count()) throw new Error("PIN remained visible in passkey mode");
    await button("Use app PIN instead").click();
    const pinDigits = p.getByRole("group", { name: "App PIN", exact: true }).locator("input");
    if ((await pinDigits.evaluateAll((inputs) => inputs.map((i) => i.value).join(""))) !== "") throw new Error("Mode switch retained PIN");
    await fillAppPin(p, "012345");
    await ready();
    await menu("App security");
    await button("Remove app PIN").click();
    if (await button("Use passkey instead").isVisible()) await button("Use passkey instead").click();
    await button("Unlock with passkey").click();
    await button("Save protection").click();
    await ready();
    await menu("App security");
    if (await button("Remove passkey unlock").count()) throw new Error("Last method removable");
    await button("Close").click();
    await ready();
    await menu("Lock app");
    if (!(await p.getByRole("dialog").count())) await button("Unlock").click();
    if (await p.getByLabel("App PIN", { exact: true }).count()) throw new Error("Removed PIN still offered");
    if (await button("Use passkey instead").isVisible()) await button("Use passkey instead").click();
    await button("Unlock with passkey").click();
    await ready();
    return {
      realBrowserWebAuthnWithVirtualAuthenticator: true,
      prfRoundTrip: true,
      reload: true,
      pinFallback: true,
      methodRemoval: true,
      lastMethodProtected: true,
    };
  } catch (error) {
    throw new Error(
      String(error) +
        " TRACE: " +
        JSON.stringify(await p.evaluate(() => window.__vaultTrace)) +
        " UI: " +
        (await p.locator("body").innerText()),
    );
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }
}
