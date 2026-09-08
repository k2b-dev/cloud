async function _run(page) {
  const context = await page
    .context()
    .browser()
    .newContext({ locale: "en", viewport: { width: 390, height: 844 } });
  const p = await context.newPage();
  const events = [];
  let intentionallyDropped = false;
  p.on("pageerror", (e) => {
    // WebKit reports the deliberately aborted decision as an access-control page error.
    if (
      intentionallyDropped &&
      (e.message.includes("43220/api/auth/app-approval/v1/device") ||
        e.message.includes("43220/api/auth/app-approval/v1/pairings/claim")) &&
      e.message.includes("access control")
    )
      return;
    events.push(e.message);
  });
  const post = async (issuer, path, data = {}) => {
    const r = await context.request.post(issuer + "/fixture/" + path, { data });
    if (!r.ok()) throw new Error(path + ": HTTP " + r.status());
    return r.json();
  };
  const a = "http://127.0.0.1:43220",
    b = "http://127.0.0.1:43221";
  let step = "first-pair";
  try {
    const first = await post(a, "pair");
    await p.goto(first.link);
    if (p.url().includes("#")) throw new Error("Pairing fragment retained");
    step = "first-fill";
    await p.getByRole("dialog").locator("input").nth(0).fill("Personal Cloud", { timeout: 5000 });
    let claims = 0;
    await context.route("**/api/auth/app-approval/v1/pairings/claim", async (route) => {
      claims++;
      await route.fetch();
      intentionallyDropped = true;
      await route.abort();
    });
    await p.getByRole("button", { name: "Trust Cloud and pair" }).click();
    await p.locator(".auth-comparison").waitFor();
    const code = await p.locator(".auth-comparison").textContent();
    await context.unroute("**/api/auth/app-approval/v1/pairings/claim");
    if (claims !== 1) throw new Error("Claim was retried after a lost response");
    await p.getByRole("checkbox", { name: "Both codes match." }).check();
    await post(a, "confirm", { pairingId: first.pairingId, comparison: code });
    await p.getByRole("button", { name: "Finish pairing" }).click({ timeout: 15000 });
    await p.getByRole("heading", { name: "Personal Cloud", exact: true }).waitFor();
    step = "second-pair";
    const second = await post(b, "pair");
    await p.getByRole("button", { name: "Menu", exact: true }).click();
    await p.getByRole("menuitem", { name: "Add Cloud", exact: true }).click();
    await p.getByRole("dialog").locator("input").nth(0).fill(second.link);
    await p.getByRole("button", { name: "Continue", exact: true }).click();
    await p.getByRole("dialog").locator("input").nth(0).fill("Work Cloud");
    await p.getByRole("button", { name: "Trust Cloud and pair" }).click();
    await p.locator(".auth-comparison").waitFor();
    const codeB = await p.locator(".auth-comparison").textContent();
    // Reload mid-pairing, then recover the same stored key from the same link.
    step = "reload-pairing";
    await p.goto("http://127.0.0.1:4178/");
    await p.goto(second.link);
    await p.getByRole("dialog").locator("input").nth(0).fill("Temporary label");
    await p.getByRole("button", { name: "Trust Cloud and pair" }).click();
    await p.locator(".auth-comparison").waitFor();
    if ((await p.locator(".auth-comparison").textContent()) !== codeB) throw new Error("Recovery changed comparison");
    await p.getByRole("checkbox", { name: "Both codes match." }).check();
    await post(b, "confirm", { pairingId: second.pairingId, comparison: codeB });
    await p.getByRole("button", { name: "Finish pairing" }).click({ timeout: 15000 });
    await p.getByRole("heading", { name: "Work Cloud", exact: true }).waitFor();
    await p.reload();
    const dismiss = p.getByRole("button", { name: "Continue in browser", exact: true });
    if (await dismiss.isVisible()) await dismiss.click();
    const keys = await p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("cloud-login", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const bindings = await new Promise((resolve, reject) => {
        const r = db.transaction("bindings").objectStore("bindings").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const result = [];
      for (const v of bindings) {
        let exported = false;
        try {
          await crypto.subtle.exportKey("jwk", v.key.privateKey);
          exported = true;
        } catch {}
        result.push({ issuer: v.issuer, extractable: v.key.privateKey.extractable, exported, x: v.key.publicKey.x });
      }
      db.close();
      return result;
    });
    if (keys.length !== 2 || keys.some((k) => k.extractable || k.exported) || keys[0].x === keys[1].x)
      throw new Error("Key isolation/persistence failed");
    const loginA = await post(a, "start"),
      loginB = await post(b, "start");
    const cloudA = p.locator(".auth-cloud").filter({ has: p.getByRole("heading", { name: "Personal Cloud", exact: true }) });
    const cloudB = p.locator(".auth-cloud").filter({ has: p.getByRole("heading", { name: "Work Cloud", exact: true }) });
    await cloudA.getByRole("button", { name: new RegExp(loginA.comparison) }).waitFor({ timeout: 20000 });
    await cloudB.getByRole("button", { name: new RegExp(loginB.comparison) }).waitFor({ timeout: 20000 });
    if ((await post(a, "status", loginA)).state !== "pending") throw new Error("Auto approval");
    await cloudA.getByRole("button", { name: new RegExp(loginA.comparison) }).click();
    if (await p.getByRole("button", { name: "Approve sign-in", exact: true }).isEnabled())
      throw new Error("Missing explicit comparison gate");
    await p.getByRole("checkbox", { name: "I started this sign-in and the codes match." }).check();
    await p.getByRole("button", { name: "Approve sign-in", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    if ((await post(a, "status", loginA)).state !== "approved" || (await post(b, "status", loginB)).state !== "pending")
      throw new Error("Cross-Cloud decision leak");
    await cloudB.getByRole("button", { name: new RegExp(loginB.comparison) }).click();
    await p.getByRole("button", { name: "Deny", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    if ((await post(b, "status", loginB)).state !== "denied") throw new Error("Denial failed");
    step = "lost-response";
    const lost = await post(a, "start");
    await cloudA.getByRole("button", { name: new RegExp(lost.comparison) }).waitFor({ timeout: 20000 });
    let decisions = 0;
    await context.route("**/api/auth/app-approval/v1/device", async (route) => {
      const body = route.request().postDataJSON();
      if (body.proof.command.operation === "decide" && body.proof.command.requestId === lost.requestId) {
        decisions++;
        intentionallyDropped = true;
        await route.abort();
      } else await route.continue();
    });
    await cloudA.getByRole("button", { name: new RegExp(lost.comparison) }).click();
    await p.getByRole("checkbox", { name: "I started this sign-in and the codes match." }).check();
    await p.getByRole("button", { name: "Approve sign-in", exact: true }).click();
    await p.getByRole("alert").waitFor();
    await p.getByRole("button", { name: "Close", exact: true }).click();
    const other = await context.newPage();
    await other.goto("http://127.0.0.1:4178/");
    await other
      .locator(".auth-cloud")
      .filter({ has: other.getByRole("heading", { name: "Personal Cloud", exact: true }) })
      .getByRole("button", { name: new RegExp(lost.comparison) })
      .click({ timeout: 20000 });
    await other.getByRole("checkbox", { name: "I started this sign-in and the codes match." }).check();
    await other.getByRole("button", { name: "Approve sign-in", exact: true }).click();
    await other.getByRole("alert").waitFor();
    if (decisions !== 1 || (await post(a, "status", lost)).state !== "pending") throw new Error("Decision retried across tabs");
    await other.close();
    await context.unroute("**/api/auth/app-approval/v1/device");
    step = "independent-failure";
    await post(a, "enabled", { enabled: false });
    const working = await post(b, "start");
    await cloudB.getByRole("button", { name: new RegExp(working.comparison) }).waitFor({ timeout: 20000 });
    await cloudA.getByRole("status").waitFor({ timeout: 20000 });
    await post(a, "enabled", { enabled: true });
    step = "foreground-only";
    await p.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    let hiddenRequests = 0;
    const count = (r) => {
      if (r.url().includes("/api/auth/app-approval/")) hiddenRequests++;
    };
    p.on("request", count);
    await p.waitForTimeout(6500);
    p.off("request", count);
    if (hiddenRequests) throw new Error("Background polling");
    await p.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    step = "revocation";
    await cloudB.getByRole("button", { name: "Disconnect Cloud: Work Cloud", exact: true }).click();
    await p.getByRole("button", { name: "Revoke device", exact: true }).click();
    await p.getByRole("dialog").waitFor({ state: "hidden" });
    if (await p.getByRole("heading", { name: "Work Cloud", exact: true }).count()) throw new Error("Revocation did not remove binding");
    const devices = await post(b, "devices");
    if (!devices.items.some((d) => d.revokedAt)) throw new Error("Server device not revoked");
    await p.screenshot({ path: "output/playwright/pwa-clouds.png", fullPage: true });
    if (events.length) throw new Error(events.join("\n"));
    return {
      pairedClouds: 2,
      copyPaste: true,
      sameDeviceFragment: true,
      reloadRecovery: true,
      lostClaimRecovery: true,
      keysNonExtractable: true,
      approvalIsolated: true,
      explicitDenial: true,
      lostResponseAcrossTabs: true,
      independentFailure: true,
      foregroundOnly: true,
      revocation: true,
    };
  } catch (e) {
    throw new Error(step + ": " + String(e) + " UI: " + (await p.locator(".auth-clouds").allTextContents()).join(" "));
  } finally {
    await context.close();
  }
}
