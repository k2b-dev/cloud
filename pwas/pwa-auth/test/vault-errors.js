async function _run(page) {
  const results = [];
  for (const mode of ["legacy", "corrupt", "background", "idle", "atomic"]) {
    const context = await page
      .context()
      .browser()
      .newContext({ locale: "en", viewport: { width: 390, height: 844 } });
    const p = await context.newPage();
    const button = (name) => p.getByRole("button", { name, exact: true });
    const ready = () => p.waitForFunction(() => !history.state?.k2bDialog);
    try {
      await p.goto("http://127.0.0.1:4178/");
      await button("Continue in browser").click();
      await ready();
      if (mode === "legacy") {
        await p.evaluate(async () => {
          const db = await new Promise((resolve) => {
            const request = indexedDB.open("cloud-login", 2);
            request.onsuccess = () => resolve(request.result);
          });
          await new Promise((resolve) => {
            const tx = db.transaction("bindings", "readwrite");
            tx.objectStore("bindings").put({ label: "LEGACY SECRET" }, "legacy");
            tx.oncomplete = resolve;
          });
          db.close();
        });
        await p.reload();
        await p.getByText("Protect your existing connections", { exact: true }).waitFor();
        if ((await p.locator("body").innerText()).includes("LEGACY SECRET")) throw new Error("Legacy metadata visible");
      } else {
        if (mode === "atomic")
          await p.evaluate(() => {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, key) {
              const request = put.call(this, value, key);
              if (this.name === "vault" && key === "header") this.transaction.abort();
              return request;
            };
          });
        await button("Add Cloud").click();
        if (mode === "atomic") {
          await p.getByRole("alert").waitFor();
          if (await p.getByRole("dialog").count()) throw new Error("Failed setup opened pairing");
          await p.reload();
          await button("Add Cloud").click();
        }
        await p.getByLabel("Pairing link", { exact: true }).waitFor();
        if (mode === "background" || mode === "idle") {
          await p.evaluate((kind) => {
            const now = Date.now;
            if (kind === "background") {
              Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
              document.dispatchEvent(new Event("visibilitychange"));
            }
            Date.now = () => now() + 300_001;
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
            document.dispatchEvent(new Event("pointerdown"));
          }, mode);
          await p.waitForTimeout(1100);
          await p.getByLabel("Pairing link", { exact: true }).waitFor();
          if (await p.locator(".k2b-pin-input").count()) throw new Error("Local vault locked");
          results.push({ mode, passed: true });
          continue;
        }
        await button("Close").click();
        await ready();
        if (mode === "atomic") {
          results.push({ mode, passed: true });
          continue;
        }
        await p.evaluate(async () => {
          const db = await new Promise((resolve) => {
            const request = indexedDB.open("cloud-login", 2);
            request.onsuccess = () => resolve(request.result);
          });
          await new Promise((resolve) => {
            const tx = db.transaction("vault", "readwrite");
            const store = tx.objectStore("vault");
            const request = store.get("header");
            request.onsuccess = () => store.put({ ...request.result, config: { version: 999 } }, "header");
            tx.oncomplete = resolve;
          });
          db.close();
        });
        await p.reload();
      }
      if (mode === "corrupt") {
        await button("Menu").click();
        await p.getByRole("menuitem", { name: "Reset Cloud Login", exact: true }).click();
      } else await button("Reset Cloud Login").click();
      await p.getByRole("checkbox", { name: "I understand that I must pair my Clouds again." }).check();
      await p.getByRole("dialog").getByRole("button", { name: "Reset Cloud Login", exact: true }).click();
      await ready();
      await button("Add Cloud").waitFor();
      results.push({ mode, passed: true });
    } finally {
      await context.close();
    }
  }
  return results;
}
