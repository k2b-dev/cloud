import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../../../ui/test/browser";
import { startOfflineNotebookFixture } from "./offline.browser-fixture";

let browser: Browser;
let server: Awaited<ReturnType<typeof startOfflineNotebookFixture>>;
beforeAll(async () => {
  server = await startOfflineNotebookFixture();
  browser = await launchBrowser();
}, 60_000);
beforeEach(() => server.reset());
afterAll(async () => {
  await browser?.close();
  server?.stop();
});

test("Notebook typing survives a discarded page and clears device input only after durable storage", async () => {
  const context = await browser.newContext();
  try {
    let page = await context.newPage();
    const errors = pageErrors(page);
    await page.goto(server.url.href);
    await page
      .waitForFunction(() => window.offlineNotebook?.ready() && window.offlineNotebook.text() === "Saved\n", null, { timeout: 3000 })
      .catch((error) => {
        throw new Error(JSON.stringify(errors), { cause: error });
      });
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Every typed character survives.");
    await page.waitForFunction(() => window.offlineNotebook.text().endsWith("Every typed character survives."));
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
    // Closing a page does not rely on beforeunload or a graceful editor disposal.
    await page.close();
    page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.text() === "Saved\nEvery typed character survives.");
    await page.request.get(new URL("/accept", server.url).href);
    await page.request.get(new URL("/drop", server.url).href);
    await page.waitForFunction(() => !window.offlineNotebook.connected());
    await page.evaluate(() => window.offlineNotebook.reconnect());
    await page.waitForFunction(() => window.offlineNotebook.device().pending);
    // A transport echo is still no committed snapshot receipt.
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
    await page.request.get(new URL("/receipts", server.url).href);
    await page.request.get(new URL("/drop", server.url).href);
    await page.waitForFunction(() => !window.offlineNotebook.connected());
    await page.evaluate(() => window.offlineNotebook.reconnect());
    await page.waitForFunction(() => !window.offlineNotebook.device().pending);
    expect(server.text()).toBe("Saved\nEvery typed character survives.");
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

test("terminal recovery keeps ignored input on the device through a fresh page", async () => {
  const context = await browser.newContext();
  try {
    let page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.request.get(new URL("/terminal", server.url).href);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Unsent after sync ended");
    await page.waitForFunction(() => window.offlineNotebook.device().recovery);
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    const before = await page.evaluate(() => window.offlineNotebook.text());
    await page.close();
    page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready() && window.offlineNotebook.device().recovery);
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe(before);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
    // This is the explicit discard action; ignoring recovery never deletes the record.
    await page.evaluate(() => window.offlineNotebook.discard());
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

test("first edits and deletions before the live socket opens survive reload without duplicating the saved base", async () => {
  const context = await browser.newContext();
  try {
    let page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    expect(await page.evaluate(() => window.offlineNotebook.connected())).toBe(false);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Replacement with the saved text deleted");
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.close();
    page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Replacement with the saved text deleted");
    await page.request.get(new URL("/accept", server.url).href);
    await page.request.get(new URL("/receipts", server.url).href);
    await page.request.get(new URL("/drop", server.url).href);
    await page.waitForFunction(() => !window.offlineNotebook.connected());
    await page.evaluate(() => window.offlineNotebook.reconnect());
    await page.waitForFunction(() => !window.offlineNotebook.device().pending);
    expect(server.text()).toBe("Replacement with the saved text deleted");
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

test("a failed device write is visible, retry saves the latest input, and a fresh editor recovers it", async () => {
  const context = await browser.newContext();
  try {
    let page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.name === "drafts") throw new DOMException("Device full", "QuotaExceededError");
        return put.call(this, value, key);
      };
      Object.assign(window, {
        restoreDeviceWrites: () => {
          IDBObjectStore.prototype.put = put;
        },
      });
    });
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Retain input through a storage failure");
    await page.waitForFunction(() => window.offlineNotebook.device().failed);
    expect(await page.getByText("This device could not save your changes.", { exact: false }).count()).toBe(1);
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(false);
    await page.evaluate(() => window.restoreDeviceWrites());
    await page.getByRole("button", { name: "Retry saving", exact: true }).click();
    await page.waitForFunction(() => window.offlineNotebook.device().saved && !window.offlineNotebook.device().failed);
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.close();
    page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nRetain input through a storage failure");
  } finally {
    await context.close();
  }
}, 30_000);

test("an unexpected IndexedDB close keeps server sync alive and retry reopens device storage", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const databases: IDBDatabase[] = [];
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args: Parameters<IDBFactory["open"]>) => {
        const request = open(...args);
        request.addEventListener("success", () => databases.push(request.result));
        return request;
      };
      Object.assign(window, { closeDeviceDatabases: () => databases.forEach((db) => db.dispatchEvent(new Event("close"))) });
    });
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Before IDB close");
    await page.waitForFunction(() => window.offlineNotebook.connected() && window.offlineNotebook.device().saved);
    await page.evaluate(() => window.closeDeviceDatabases());
    await page.waitForFunction(() => window.offlineNotebook.device().failed);
    expect(await page.evaluate(() => window.offlineNotebook.connected())).toBe(true);
    expect(await page.locator("[data-sync-ended]").count()).toBe(0);
    await page.keyboard.type(" and after");
    await page.getByRole("button", { name: "Retry saving", exact: true }).click();
    await page.waitForFunction(() => window.offlineNotebook.device().saved && !window.offlineNotebook.device().failed);
    await page.reload();
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nBefore IDB close and after");
  } finally {
    await context.close();
  }
}, 30_000);

test("a committed receipt clears covered pending input before sticky incomplete-history recovery", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.request.get(new URL("/accept", server.url).href);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Already committed before closing");
    await page.waitForFunction(() => window.offlineNotebook.device().saved);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
    await page.request.get(new URL("/receipts", server.url).href);
    await page.request.get(new URL("/history-incomplete", server.url).href);
    await page.reload();
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    expect(await page.evaluate(() => window.offlineNotebook.device().pending)).toBe(false);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
    expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe("true");
  } finally {
    await context.close();
  }
}, 30_000);

test("an older generation stays visible and kept until an explicit discard", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Previous generation input");
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.request.get(new URL("/restore", server.url).href);
    await page.reload();
    await page.waitForFunction(() => window.offlineNotebook?.ready() && window.offlineNotebook.device().recovery);
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nPrevious generation input");
    expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe("false");
    await page.getByRole("button", { name: "Keep on this device", exact: true }).click();
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
    expect(server.text()).toBe("Restored note\n");
    await page.getByRole("button", { name: "Discard device changes", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Discard device changes", exact: true }).click();
    await page.waitForFunction(() => window.offlineNotebook?.ready() && !window.offlineNotebook.device().recovery);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Restored note\n");
  } finally {
    await context.close();
  }
}, 30_000);

test("changed authorization cannot load pending bytes and retry requires fresh server authorization", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Private pending words");
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.request.get(new URL("/deny", server.url).href);
    await page.reload();
    await page.getByText("Your account or access changed.", { exact: false }).waitFor();
    expect(await page.getByRole("button", { name: "Copy text", exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Edit in this tab only", exact: true }).count()).toBe(0);
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\n");
    expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe("false");
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
    await page.request.get(new URL("/authorize", server.url).href);
    await page.getByRole("button", { name: "Retry saving", exact: true }).click();
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nPrivate pending words");
  } finally {
    await context.close();
  }
}, 30_000);

declare global {
  interface Window {
    restoreDeviceWrites(): void;
    closeDeviceDatabases(): void;
  }
}

test("sign-in recovery resumes normally and durable receipts still clear device input", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.request.get(new URL("/session-expired", server.url).href);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    // One input transaction: the simulated expired session makes subsequent keystrokes read-only.
    await page.keyboard.insertText("Resume without discarding");
    await page.locator('[data-sync-ended="SESSION_EXPIRED"]').waitFor();
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    expect(await page.evaluate(() => window.offlineNotebook.device().recovery)).toBe(false);
    await page.request.get(new URL("/accept", server.url).href);
    await page.request.get(new URL("/receipts", server.url).href);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForFunction(() => !document.querySelector("[data-sync-ended]"));
    await page.waitForFunction(() => !window.offlineNotebook.device().pending);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
    expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe("true");
    expect(server.text()).toBe("Saved\nResume without discarding");
  } finally {
    await context.close();
  }
}, 30_000);

test("read mode offers pending input even when the note was locked after typing", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Input before the lock");
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.request.get(new URL("/lock", server.url).href);
    const readonly = new URL(server.url);
    readonly.searchParams.set("readonly", "true");
    await page.goto(readonly.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready() && window.offlineNotebook.device().recovery);
    expect(await page.getByRole("textbox", { name: "Pending text on this device", exact: true }).inputValue()).toBe(
      "Saved\nInput before the lock",
    );
    expect(await page.evaluate(() => window.offlineNotebook.connected())).toBe(false);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
  } finally {
    await context.close();
  }
}, 30_000);

test("a conflicting remote projection leaves the exact pending text visible through reload", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.request.get(new URL("/conflict", server.url).href);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText("Exact pending words");
    await page.waitForFunction(() => window.offlineNotebook.device().recovery);
    const copy = page.getByRole("textbox", { name: "Pending text on this device", exact: true });
    expect(await copy.inputValue()).toBe("Saved\nExact pending words");
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.reload();
    await page.waitForFunction(() => window.offlineNotebook?.ready() && window.offlineNotebook.device().recovery);
    expect(await copy.inputValue()).toBe("Saved\nExact pending words");
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual(["0"]);
  } finally {
    await context.close();
  }
}, 30_000);

test("a terminal lock after durable acknowledgement does not offer nonexistent device changes", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => window.offlineNotebook?.ready());
    await page.request.get(new URL("/accept", server.url).href);
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Committed input");
    expect(await page.evaluate(() => window.offlineNotebook.flush())).toBe(true);
    await page.request.get(new URL("/receipts", server.url).href);
    await page.request.get(new URL("/drop", server.url).href);
    await page.waitForFunction(() => !window.offlineNotebook.connected());
    await page.evaluate(() => window.offlineNotebook.reconnect());
    await page.waitForFunction(() => !window.offlineNotebook.device().pending);
    await page.request.get(new URL("/lock", server.url).href);
    await page.locator('[data-sync-ended="NOTE_LOCKED"]').waitFor();
    expect(await page.evaluate(() => window.offlineNotebook.device().recovery)).toBe(false);
    expect(await page.getByRole("button", { name: "Discard device changes", exact: true }).count()).toBe(0);
    expect(await page.evaluate(() => window.offlineNotebook.saved())).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

for (const failure of ["missing IndexedDB", "storage error", "quota", "server error", "network error"] as const) {
  test(`a failed device session (${failure}) offers explicit tab-only editing with a persistent warning`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      if (failure === "missing IndexedDB") await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: undefined }));
      if (failure === "storage error" || failure === "quota")
        // On the prototype: WebKit ignores a method assigned to the indexedDB instance itself.
        await page.addInitScript((quota) => {
          Object.defineProperty(IDBFactory.prototype, "open", {
            configurable: true,
            value: () => {
              throw new DOMException("Storage unavailable", quota ? "QuotaExceededError" : "SecurityError");
            },
          });
        }, failure === "quota");
      if (failure === "server error" || failure === "network error")
        await page.route("**/document?**", (route) =>
          failure === "server error" ? route.fulfill({ status: 503 }) : route.abort("failed"),
        );
      await page.goto(server.url.href);
      const notice = page.locator("[data-notebook-device-state]");
      await notice.waitFor();
      if (failure === "missing IndexedDB" || failure === "storage error" || failure === "quota")
        expect(await notice.textContent()).toContain("Device storage could not be opened.");
      expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe("false");
      await notice.getByRole("button", { name: "Edit in this tab only", exact: true }).click({ timeout: 3000 });
      await page.waitForFunction(() => document.querySelector(".cm-content")?.getAttribute("contenteditable") === "true");
      await page.locator(".cm-content").click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("Tab-only words");
      expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nTab-only words");
      expect(await notice.textContent()).toContain("Closing this tab loses changes that have not reached the server.");
      expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
      if (failure === "server error" || failure === "network error") {
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Backspace");
        expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("");
        await page.keyboard.press("ControlOrMeta+z");
        expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nTab-only words");
        await page.keyboard.press("ControlOrMeta+Shift+Z");
        expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("");
        await page.keyboard.press("ControlOrMeta+z");
        expect(await page.evaluate(() => window.offlineNotebook.text())).toBe("Saved\nTab-only words");
        await notice.getByRole("button", { name: "Retry saving", exact: true }).click();
        await notice.getByText("The connection could not be restored.", { exact: false }).waitFor();
        const expectedText = failure === "server error" ? "Remote\nSaved\nTab-only words" : "Saved\nTab-only words";
        if (failure === "server error") await page.request.get(new URL("/remote-prefix", server.url).href);
        await page.unroute("**/document?**");
        await notice.getByRole("button", { name: "Retry saving", exact: true }).click();
        await page.waitForFunction(() => window.offlineNotebook.ready());
        expect(await page.evaluate(() => window.offlineNotebook.text())).toBe(expectedText);
        await page.request.get(new URL("/accept", server.url).href);
        await page.request.get(new URL("/drop", server.url).href);
        await page.waitForFunction(() => !window.offlineNotebook.connected());
        await page.evaluate(() => window.offlineNotebook.reconnect());
        await page.waitForFunction(() => window.offlineNotebook.connected() && !window.offlineNotebook.unsent());
        expect(server.text()).toBe(expectedText);
      }
      expect(await notice.textContent()).toContain("Editing in this tab only.");
    } finally {
      await context.close();
    }
  }, 30_000);
}

for (const status of [401, 403, 404]) {
  test(`a document access failure (${status}) keeps the note read-only without a tab-only bypass`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.route("**/document?**", (route) => route.fulfill({ status }));
      await page.goto(server.url.href);
      await page.getByText("Your account or access changed.", { exact: false }).waitFor();
      expect(await page.locator(".cm-content").getAttribute("contenteditable")).toBe("false");
      expect(await page.getByRole("button", { name: "Edit in this tab only", exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  }, 30_000);
}
