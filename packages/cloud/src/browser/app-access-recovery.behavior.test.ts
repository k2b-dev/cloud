import { expect, setSystemTime, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

if (isServer) test.skip("requires browser conditions", () => {});
else {
  const bootstrap = createDomTestHarness();
  const { installAppAccessRecovery } = await import("./app-access-recovery");
  const { APP_ACCESS_REVOKED_EVENT } = await import("./live-websocket");
  bootstrap.cleanup();
  test("current app denial returns the response, preserves location and reloads once; other apps and origins do not", async () => {
    const dom = createDomTestHarness();
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    dom.window.history.replaceState(null, "", "/app/invoices/123?tab=access#row");
    let reloads = 0;
    Object.assign(dom.window.location, { reload: () => reloads++ });
    const original = window.fetch;
    let deniedApp = "other";
    window.fetch = Object.assign(
      async () => new Response("denied", { status: 403, headers: { "X-Cloud-App-Access-Denied": deniedApp } }),
      original,
    );
    const transport = window.fetch;
    const dispose = installAppAccessRecovery({ id: "invoices", routes: ["/app/invoices", "/api/invoices"] });
    try {
      await window.fetch("/api/invoices");
      expect(reloads).toBe(0);
      deniedApp = "invoices";
      await window.fetch("https://other.example/api/invoices");
      expect(reloads).toBe(0);
      expect(await (await window.fetch("/api/invoices")).text()).toBe("denied");
      expect(reloads).toBe(1);
      const url = new URL(window.location.href);
      expect(url.pathname).toBe("/app/invoices/123");
      expect(url.searchParams.get("tab")).toBe("access");
      expect(url.searchParams.get("_cloud_access")).toBe("revoked");
      expect(url.hash).toBe("#row");
      await window.fetch("/api/invoices");
      expect(reloads).toBe(1);
      dispose();
      expect(window.fetch).toBe(transport);
    } finally {
      dispose();
      window.fetch = original;
      setSystemTime();
      dom.cleanup();
    }
  });

  test("a revoked live connection affects only its owning app and releases its listener", () => {
    const dom = createDomTestHarness();
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    let reloads = 0;
    Object.assign(dom.window.location, { reload: () => reloads++ });
    const dispose = installAppAccessRecovery({ id: "invoices", routes: ["/api/invoices"] });
    const revoked = (path: string) =>
      window.dispatchEvent(new CustomEvent(APP_ACCESS_REVOKED_EVENT, { detail: `ws://${window.location.host}${path}` }));
    try {
      revoked("/api/other/live");
      revoked("/api/invoices-other/live");
      expect(reloads).toBe(0);
      revoked("/api/invoices/live");
      expect(reloads).toBe(1);
      dispose();
      revoked("/api/invoices/live");
      expect(reloads).toBe(1);
    } finally {
      dispose();
      setSystemTime();
      dom.cleanup();
    }
  });
  for (const storageBlocked of [false, true])
    test(`suppressed recovery stays visible with a manual reload (blocked storage: ${storageBlocked})`, async () => {
      const dom = createDomTestHarness();
      setSystemTime(new Date("2026-10-22T12:00:00Z"));
      let reloads = 0;
      Object.assign(dom.window.location, { reload: () => reloads++ });
      const storage = window.sessionStorage;
      const storageDescriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
      if (storageBlocked)
        Object.defineProperty(window, "sessionStorage", {
          configurable: true,
          get() {
            throw new Error("storage blocked");
          },
        });
      else storage.setItem("cloud.reload.app-access:invoices", String(new Date("2026-10-22T12:00:00Z").getTime()));
      const dispose = installAppAccessRecovery({ id: "invoices", routes: ["/api/invoices"] });
      try {
        window.dispatchEvent(new CustomEvent(APP_ACCESS_REVOKED_EVENT, { detail: `ws://${window.location.host}/api/invoices/live` }));
        await Bun.sleep(10);
        expect(reloads).toBe(0);
        const notice = document.querySelector<HTMLElement>("[data-k2b-toast]:not([data-closing])");
        expect(notice?.textContent).toContain("Your app access changed");
        notice?.querySelector<HTMLButtonElement>(".k2b-toast__action")?.click();
        expect(reloads).toBe(1);
      } finally {
        dispose();
        if (storageDescriptor) Object.defineProperty(window, "sessionStorage", storageDescriptor);
        else Reflect.deleteProperty(window, "sessionStorage");
        setSystemTime();
        dom.cleanup();
      }
    });
}
