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
  let step = "setup";
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

    const issuer = "https://account-test.example";
    const deviceId = "22222222-2222-4222-8222-222222222222";
    let revokes = 0;
    let logoFails = false;
    await p.route(issuer + "/**", async (route) => {
      const path = route.request().url().slice(issuer.length);
      if (path === "/branding/logo") {
        if (logoFails) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="blue"/></svg>',
        });
      }
      const root = "/api/auth/app-approval/v1";
      let body;
      if (path.endsWith("/info"))
        body = {
          protocol: "cloud-app-approval-v1",
          issuer,
          api: issuer + root,
          appOrigin: "http://127.0.0.1:4178",
          algorithm: "ES256",
          limits: {
            bodyBytes: 8192,
            pairingSeconds: 300,
            loginSeconds: 300,
            proofSeconds: 60,
            recentSessionSeconds: 600,
            devicesPerAccount: 20,
            pendingPerAccount: 5,
            pageSize: 20,
            pollSeconds: 5,
          },
        };
      else if (path.endsWith("/claim")) body = { deviceId, comparison: "123456", expiresAt: new Date(Date.now() + 240000).toISOString() };
      else if (path.endsWith("/result")) body = { state: "confirmed", deviceId, comparison: "123456" };
      else if (route.request().postDataJSON()?.proof?.command?.operation === "revoke") {
        revokes++;
        body = { state: "revoked" };
      } else body = { requests: [], pollAfterSeconds: 5 };
      await route.fulfill({ json: body });
    });
    await button("Add Cloud").click();
    const payload = {
      protocol: "cloud-app-approval-v1",
      issuer,
      pairingId: "11111111-1111-4111-8111-111111111111",
      secret: "A".repeat(43),
      expiresAt: new Date(Date.now() + 240000).toISOString(),
    };
    await p
      .getByLabel("Pairing link", { exact: true })
      .fill("http://127.0.0.1:4178/#pairing=" + encodeURIComponent(JSON.stringify(payload)));
    await button("Continue").click();
    await p.getByLabel("Account label", { exact: true }).fill("Test Cloud");
    await button("Trust Cloud and pair").click();
    await button("Both codes match.").click();
    await ready();
    if (!(await p.locator("section.auth-cloud.k2b-paper").count())) throw new Error("Cloud does not use Paper");
    await p.locator(".auth-cloud-logo--loaded").waitFor();
    const padding = await p.locator("section.auth-cloud").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    if (padding < 16) throw new Error("Paper has no padding: " + padding);
    const gap = await p.locator(".auth-recovery").evaluate((el) => innerHeight - el.getBoundingClientRect().bottom);
    if (gap > 50 || gap < 0) throw new Error("Recovery note is not at the bottom: " + gap);
    await p.screenshot({ path: "output/playwright/pwa-paper-padding.png" });
    if (await button("Disconnect Cloud: Test Cloud").count()) throw new Error("Direct unlink remains");
    const manage = async () => {
      await button("Menu").click();
      await p.getByRole("menuitem", { name: "Manage accounts", exact: true }).click();
    };
    step = "manage";
    await manage();
    await button("Edit label: Test Cloud").click();
    await p.getByLabel("Account label", { exact: true }).fill("Renamed Cloud");
    step = "rename";
    await button("Save").click();
    await button("Edit label: Renamed Cloud").waitFor();
    await button("Disconnect Cloud: Renamed Cloud").click();
    if (revokes) throw new Error("Delete bypassed confirmation");
    await p.getByRole("dialog").last().getByRole("button", { name: "Close", exact: true }).click();
    await button("Disconnect Cloud: Renamed Cloud").waitFor();
    if (revokes) throw new Error("Cancel revoked device");
    await button("Close").click();
    await ready();
    logoFails = true;
    step = "reload";
    await p.reload();
    await pin("012345");
    await ready();
    await p.getByRole("heading", { name: "Renamed Cloud", exact: true }).waitFor();
    await p.waitForFunction(
      () => !!document.querySelector(".auth-cloud-logo .ti-cloud") && !document.querySelector(".auth-cloud-logo img"),
    );
    step = "manage";
    await manage();
    await button("Disconnect Cloud: Renamed Cloud").click();
    step = "revoke";
    await button("Revoke device").click();
    await p.waitForFunction(() => !document.querySelector(".auth-account-row"));
    if (revokes !== 1) throw new Error("Revocation was not exactly once");
    if (errors.length) throw new Error(errors.join("\n"));
    return { paper: true, renamePersists: true, confirmation: true, cancel: true, remove: true };
  } catch (e) {
    throw new Error(step + ": " + e.message + " | " + (await p.locator("body").innerText()));
  } finally {
    await context.close();
  }
}
