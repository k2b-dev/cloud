async function _run(page) {
  const sdk = await (await import("node:fs/promises")).readFile("/tmp/cloud-login-test-sdk.js", "utf8");
  const context = await page
    .context()
    .browser()
    .newContext({ locale: "en", viewport: { width: 390, height: 844 } });
  const p = await context.newPage();
  await p.route("**/fixture-sdk.js", (route) => route.fulfill({ contentType: "text/javascript", body: sdk }));
  await p.route("https://migration.example/**", (route) => route.fulfill({ status: 503, body: "" }));
  const button = (name) => p.getByRole("button", { name, exact: true });
  const ready = () => p.waitForFunction(() => !history.state?.k2bDialog);
  const pin = async (value) => {
    await p.waitForFunction(() => !!document.querySelector("dialog .k2b-pin-input") && !document.querySelector("dialog input[readonly]"));
    const digits = p.getByRole("group", { name: "App PIN", exact: true }).locator("input");
    for (let i = 0; i < value.length; i++) await digits.nth(i).fill(value[i]);
  };
  const readHeader = () =>
    p.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("cloud-login", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = await new Promise((resolve) => {
        const request = db.transaction("vault").objectStore("vault").get("header");
        request.onsuccess = () => resolve(request.result);
      });
      db.close();
      return value;
    });
  try {
    await p.goto("http://127.0.0.1:4178/");
    await button("Continue in browser").click();
    await ready();
    // Seed an old install with a real SDK PIN method and an encrypted connected Cloud.
    await p.evaluate(async () => {
      const { appApproval } = await import("/fixture-sdk.js");
      const session = await appApproval.vault.create();
      const method = await session.pin("012345");
      const issuer = "https://migration.example";
      const deviceId = crypto.randomUUID();
      const id = JSON.stringify([issuer, deviceId]);
      const blob = await session.sealRecord(
        { id, issuer, deviceId, label: "Kept Cloud", name: "Phone", key: await session.createKey() },
        JSON.stringify(["bindings", id]),
      );
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("cloud-login", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(["vault", "bindings"], "readwrite");
        tx.objectStore("vault").put({ revision: crypto.randomUUID(), config: { version: 1, id: session.id, methods: [method] } }, "header");
        tx.objectStore("bindings").put({ id, vault: session.id, blob }, id);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      session.lock();
    });
    await p.reload();
    await p.getByRole("heading", { name: "Remove app PIN", exact: true }).last().waitFor();
    await p
      .getByText("Cloud Login no longer uses an app PIN. Enter your PIN one last time to keep your connected Clouds.")
      .last()
      .waitFor();
    const before = await readHeader();
    await pin("111111");
    await p.getByRole("alert").waitFor();
    if (JSON.stringify(before) !== JSON.stringify(await readHeader())) throw new Error("Wrong PIN changed vault");
    if (
      !(await p
        .locator("dialog input")
        .first()
        .evaluate((input) => input.readOnly))
    )
      throw new Error("Wrong PIN has no retry delay");
    await pin("012345");
    await ready();
    await p.getByRole("heading", { name: "Kept Cloud", exact: true }).waitFor();
    if ((await readHeader()).config.methods.map((method) => method.type).join() !== "local") throw new Error("PIN was not removed");
    await p.reload();
    await p.getByRole("heading", { name: "Kept Cloud", exact: true }).waitFor();
    if (await p.locator(".k2b-pin-input").count()) throw new Error("Reload asked for PIN again");
    return { wrongPinLocked: true, retryDelay: true, connectedCloudKept: true, pinRemoved: true, reloadOpens: true };
  } finally {
    await context.close();
  }
}
