async function _run(page) {
  const fillAppPin = async (target, value) => {
    await target.waitForFunction(() => !document.querySelector("dialog input:disabled, dialog input[readonly]"));
    const digits = target.getByRole("group", { name: "App PIN", exact: true }).locator("input");
    if (await digits.count()) {
      for (let i = 0; i < value.length; i++) await digits.nth(i).fill(value[i]);
    } else await target.getByLabel("App PIN", { exact: true }).fill(value);
  };

  const results = [];
  for (const mode of ["legacy", "corrupt", "atomic", "background", "idle", "late-unlock", "cancel"]) {
    const context = await page
      .context()
      .browser()
      .newContext({ locale: "en", viewport: { width: 390, height: 844 } });
    const p = await context.newPage();
    const button = (name) => p.getByRole("button", { name, exact: true });
    const ready = () => p.waitForFunction(() => !history.state?.cloudLoginDialog);
    const menu = async (name) => {
      await button("Menu").click();
      await p.getByRole("menuitem", { name, exact: true }).click();
    };
    const fill = async (value) => {
      await fillAppPin(p, value);
      await p.getByLabel("Repeat app PIN", { exact: true }).fill(value);
    };
    const readHeader = () =>
      p.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const r = indexedDB.open("cloud-login", 2);
          r.onsuccess = () => resolve(r.result);
        });
        const value = await new Promise((resolve) => {
          const r = db.transaction("vault").objectStore("vault").get("header");
          r.onsuccess = () => resolve(r.result);
        });
        db.close();
        return value;
      });
    try {
      await p.goto("http://localhost:4178/");
      await button("Continue in browser").click();
      await ready();
      if (mode === "legacy") {
        await p.evaluate(async () => {
          const db = await new Promise((resolve) => {
            const r = indexedDB.open("cloud-login", 2);
            r.onsuccess = () => resolve(r.result);
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
      } else if (mode === "cancel") {
        await button("Add Cloud").click();
        await p.evaluate(() => {
          Object.defineProperty(navigator, "credentials", {
            configurable: true,
            value: {
              create: (options) =>
                new Promise((resolve, reject) => {
                  window.credentialPending = true;
                  options.signal.addEventListener("abort", () => {
                    window.credentialAborted = true;
                    reject(new DOMException("Cancelled", "AbortError"));
                  });
                }),
            },
          });
        });
        await button("Use a passkey · Recommended").click();
        await p.waitForFunction(() => window.credentialPending);
        await p.keyboard.press("Escape");
        await ready();
        await p.waitForFunction(() => window.credentialAborted);
        if (await readHeader()) throw new Error("Cancelled setup persisted");
        await button("Add Cloud").click();
        await p.getByRole("heading", { name: "Protect Cloud Login" }).waitFor();
        results.push({ mode, passed: true });
        continue;
      } else {
        await button("Add Cloud").click();
        await button("Set a six-digit app PIN").click();
        await fill("012345");
        await button("Save protection").click();
        await p.getByRole("heading", { name: "Add Cloud", exact: true }).waitFor();
        await button("Close").click();
        await ready();
        if (mode === "idle") {
          await p.evaluate(() => {
            const now = Date.now;
            Date.now = () => now() + 300_001;
            document.dispatchEvent(new Event("pointerdown"));
          });
          await button("Unlock").waitFor();
          results.push({ mode, passed: true });
          continue;
        }
        if (mode === "late-unlock") {
          await menu("Lock app");
          await button("Unlock").click();
          await p.evaluate(() => {
            const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
            crypto.subtle.decrypt = async (...args) => {
              const value = await decrypt(...args);
              await new Promise((resolve) => {
                window.releaseUnlock = resolve;
              });
              return value;
            };
          });
          await fillAppPin(p, "012345");
          await p.waitForFunction(() => window.releaseUnlock);
          await p.keyboard.press("Escape");
          await ready();
          await p.evaluate(() => window.releaseUnlock());
          await p.waitForTimeout(200);
          await button("Unlock").waitFor();
          if (await p.getByRole("button", { name: "Add Cloud", exact: true }).count()) throw new Error("Late result unlocked app");
          results.push({ mode, passed: true });
          continue;
        }
        if (mode === "background") {
          await button("Add Cloud").click();
          await p.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await button("Unlock").waitFor();
          await p.getByRole("dialog").waitFor({ state: "hidden" });
          await p.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await button("Unlock").waitFor();
          results.push({ mode, passed: true });
          continue;
        }
        if (mode === "atomic") {
          const before = await readHeader();
          await menu("App security");
          await button("Change app PIN").click();
          await fillAppPin(p, "012345");
          await fill("654321");
          await p.evaluate(() => {
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (value, key) {
              const request = put.call(this, value, key);
              if (this.name === "vault" && key === "header") this.transaction.abort();
              return request;
            };
          });
          await button("Save protection").click();
          await p.getByRole("alert").waitFor();
          if (JSON.stringify(before) !== JSON.stringify(await readHeader())) throw new Error("Failed transaction changed protection");
          await p.reload();
          await button("Unlock").click();
          await fillAppPin(p, "012345");
          await ready();
          results.push({ mode, passed: true });
          continue;
        }
        await p.evaluate(async () => {
          const db = await new Promise((resolve) => {
            const r = indexedDB.open("cloud-login", 2);
            r.onsuccess = () => resolve(r.result);
          });
          await new Promise((resolve) => {
            const tx = db.transaction("vault", "readwrite"),
              store = tx.objectStore("vault"),
              r = store.get("header");
            r.onsuccess = () => store.put({ ...r.result, config: { version: 999 } }, "header");
            tx.oncomplete = resolve;
          });
          db.close();
        });
        await p.reload();
      }
      if (mode === "corrupt") await menu("Reset Cloud Login");
      else await button("Reset Cloud Login").click();
      await p.getByRole("checkbox", { name: "I understand that I must pair my Clouds again." }).check();
      await p.getByRole("dialog").getByRole("button", { name: "Reset Cloud Login", exact: true }).click();
      await ready();
      await button("Add Cloud").waitFor();
      if (await readHeader()) throw new Error("Reset retained header");
      results.push({ mode, passed: true });
    } catch (error) {
      throw new Error(mode + ": " + error + " UI: " + (await p.locator("body").innerText()));
    } finally {
      await context.close();
    }
  }
  return results;
}
