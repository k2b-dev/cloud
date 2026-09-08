async function _run(page, protection = "pin") {
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
  const attachAuthenticator = async (target) => {
    const cdp = await context.newCDPSession(target);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
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
  };
  if (protection !== "pin") await attachAuthenticator(p);
  const unlock = async (target, dialog = false) => {
    if (!dialog) {
      await target.getByRole("button", { name: "Unlock", exact: true }).waitFor();
      const intro = target.getByRole("button", { name: "Continue in browser", exact: true });
      if (await intro.isVisible()) {
        await intro.click();
        await target.waitForFunction(() => !history.state?.cloudLoginDialog);
      }
      await target.getByRole("button", { name: "Unlock", exact: true }).click();
    }
    if (protection === "passkey") await target.getByRole("button", { name: "Unlock with passkey", exact: true }).click();
    else {
      await fillAppPin(target, "012345");
    }
    if (!dialog) await target.waitForFunction(() => !history.state?.cloudLoginDialog);
  };
  const events = [];
  let intentionallyDropped = false;
  let navigatingDuringPairing = false;
  p.on("pageerror", (e) => {
    // WebKit reports the deliberately aborted decision as an access-control page error.
    if (
      intentionallyDropped &&
      (e.message.includes("43220/api/auth/app-approval/v1/device") ||
        e.message.includes("43220/api/auth/app-approval/v1/pairings/claim")) &&
      e.message.includes("access control")
    )
      return;
    if (
      navigatingDuringPairing &&
      e.message.includes("43221/api/auth/app-approval/v1/pairings/result") &&
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
    if (protection !== "pin") await p.getByRole("button", { name: "Use a passkey · Recommended", exact: true }).click();
    else {
      await p.getByRole("button", { name: "Set a six-digit app PIN", exact: true }).click();
      await fillAppPin(p, "012345");
      await p.getByLabel("Repeat app PIN", { exact: true }).fill("012345");
      await p.getByRole("button", { name: "Save protection", exact: true }).click();
    }
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
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
    if (protection === "both") {
      await p.getByRole("button", { name: "Menu", exact: true }).click();
      await p.getByRole("menuitem", { name: "App security", exact: true }).click();
      await p.getByRole("button", { name: "Set a six-digit app PIN", exact: true }).click();
      await p.getByRole("button", { name: "Unlock with passkey", exact: true }).click();
      await fillAppPin(p, "012345");
      await p.getByLabel("Repeat app PIN", { exact: true }).fill("012345");
      await p.getByRole("button", { name: "Save protection", exact: true }).click();
      await p.waitForFunction(() => !history.state?.cloudLoginDialog);
    }
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
    navigatingDuringPairing = true;
    await p.goto("http://localhost:4178/");
    await p.goto(second.link);
    await unlock(p, true);
    await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
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
    await unlock(p);
    const keys = await p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("cloud-login", 2);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const bindings = await new Promise((resolve, reject) => {
        const r = db.transaction("bindings").objectStore("bindings").getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      db.close();
      return bindings.map((v) => ({ sealed: !!v.blob?.data && !!v.blob?.iv && !v.key && !v.label, data: v.blob?.data }));
    });
    if (keys.length !== 2 || keys.some((k) => !k.sealed) || keys[0].data === keys[1].data)
      throw new Error("Encrypted key isolation/persistence failed");
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
    // CDP does not export a virtual authenticator's PRF secret. Test PRF recovery in the same authenticator; PIN/both also exercise a second tab.
    const other = protection === "passkey" ? p : await context.newPage();
    await other.goto("http://localhost:4178/");
    await unlock(other);
    await other
      .locator(".auth-cloud")
      .filter({ has: other.getByRole("heading", { name: "Personal Cloud", exact: true }) })
      .getByRole("button", { name: new RegExp(lost.comparison) })
      .click({ timeout: 20000 });
    await other.getByRole("checkbox", { name: "I started this sign-in and the codes match." }).check();
    await other.getByRole("button", { name: "Approve sign-in", exact: true }).click();
    await other.getByRole("alert").waitFor();
    if (decisions !== 1 || (await post(a, "status", lost)).state !== "pending") throw new Error("Decision retried across tabs");
    if (other !== p) await other.close();
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
    await unlock(p);
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
      protection,
      pairedClouds: 2,
      copyPaste: true,
      sameDeviceFragment: true,
      reloadRecovery: true,
      lostClaimRecovery: true,
      keysNonExtractable: true,
      approvalIsolated: true,
      explicitDenial: true,
      lostResponseAcrossTabs: protection !== "passkey",
      lostResponseAfterReload: protection === "passkey",
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
