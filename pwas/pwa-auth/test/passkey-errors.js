async function _run(page) {
  const context = await page.context().browser().newContext({ locale: "en" });
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
      hasPrf: false,
    },
  });
  try {
    await p.goto("http://localhost:4178/");
    await p.getByRole("button", { name: "Continue in browser", exact: true }).click();
    await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    await p.getByRole("button", { name: "Add Cloud", exact: true }).click();
    await p.getByRole("button", { name: "Set up passkey", exact: true }).click();
    await p.getByRole("alert").waitFor();
    const header = await p.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const r = indexedDB.open("cloud-login", 2);
        r.onsuccess = () => resolve(r.result);
      });
      const h = await new Promise((resolve) => {
        const r = db.transaction("vault").objectStore("vault").get("header");
        r.onsuccess = () => resolve(r.result);
      });
      db.close();
      return h;
    });
    if (header) throw new Error("Provider without PRF created a vault");
    await p.getByRole("button", { name: "Set a six-digit app PIN", exact: true }).click();
    await p.getByLabel("App PIN", { exact: true }).fill("012345");
    await p.getByLabel("Repeat PIN", { exact: true }).fill("012345");
    await p.getByRole("button", { name: "Save protection", exact: true }).click();
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
    return { missingProviderPrfRejected: true, noImplicitFallback: true, explicitPinSetupWorks: true };
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }
}
