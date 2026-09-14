import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render, isServer } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires DOM conditions", () => {});
else
  test("CSV preferences decode original bytes, survive remount and expose an adjustments dialog", async () => {
    const dom = createDomTestHarness();
    const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    const { default: FileView } = await import("../src/content/FileView");
    const bytes = Uint8Array.from([110, 97, 109, 101, 59, 118, 97, 108, 117, 101, 10, 83, 252, 100, 59, 52, 50]);
    const encoded = btoa(String.fromCharCode(...bytes));
    dom.window.localStorage.setItem("csv-test", JSON.stringify({ encoding: "windows-1252", delimiter: ";", view: "table" }));
    const mount = () =>
      render(
        () =>
          createComponent(FileView, {
            file: { path: "/sample.csv", size: bytes.length, mediaType: "text/csv" },
            previewPreferencesKey: "csv-test",
            load: async () => ({ encoding: "base64", content: encoded, mediaType: "text/csv" }),
          }),
        dom.root,
      );
    let dispose = mount();
    try {
      await Bun.sleep(30);
      expect(dom.root.querySelectorAll("th")).toHaveLength(2);
      expect(dom.root.textContent).toContain("Süd");
      const settings =
        dom.root.querySelector<HTMLButtonElement>('button[title="CSV display settings"]') ??
        [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.innerHTML.includes("ti-adjustments-horizontal"),
        );
      expect(settings).toBeDefined();
      settings!.click();
      await Bun.sleep(30);
      expect(dom.document.querySelector("dialog")).not.toBeNull();
      expect(dom.document.querySelectorAll('[role="combobox"]')).toHaveLength(3);
      dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
      dispose();
      dom.window.localStorage.setItem("csv-test", JSON.stringify({ encoding: "windows-1252", delimiter: ";", view: "raw" }));
      dispose = mount();
      await Bun.sleep(30);
      expect(dom.root.querySelector("table")).toBeNull();
      expect(dom.root.textContent).toContain("Süd;42");
      expect(encoded).toBe(btoa(String.fromCharCode(...bytes)));
    } finally {
      dispose();
      if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
      dom.cleanup();
    }
  });
